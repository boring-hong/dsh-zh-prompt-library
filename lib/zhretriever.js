// Chinese retrieval rail, shared by two consumers:
//   dsh-zh-prompt-library  — the DSH plugin (host half runs it in-process)
//   zh-prompt-search-mcp   — the standalone MCP server (vendored copy, kept in sync by sync-corpus.mjs)
//
// Why this exists: the English prompts.chat index (2,306 entries, 95% English) can never match a
// Chinese vertical request, and translating first only partly fixed it — the library simply has
// no water-plant / 公众号 / 法律 material. This rail searches sources that DO have it:
//
//   local    ~/.dsh/skills/*.md      hand-written Chinese expert instructions (read live, not embedded,
//                                    because the user keeps editing them). Minimum length and maximum
//                                    injected size are configurable — see SKILLS_MIN_CJK / SKILLS_MAX_CHARS
//                                    below; the defaults are deliberately permissive so that short but
//                                    genuine runbooks are indexed rather than silently skipped.
//   general  lib/zh-corpus.json      filtered Chinese role prompts from the delivered corpus
//   template lib/zh-corpus.json      the 24 firefly task skeletons (对联 / 古诗 / 翻译 / 程序 …)
//
// Tokenizer note — this is the fix for the Chinese proper-noun problem: an alphanumeric run is one
// indivisible token, so React / COD / MBR / AAOA / gpt-4 are never shredded into useless bigrams.
// A CJK run yields 2-grams, which is the useful granularity for Chinese retrieval.

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const STOP = new Set(
  ('的,了,和,是,在,我,有,就,不,人,都,一,一个,上,也,很,到,说,要,去,你,会,着,没有,看,好,自己,这,那,他,她,它,们,与,及,或,请,帮,把,被,给,让,用,对,从,为,以,等,可,能,将,需要,进行,以下,下面,如下,要求,任务,内容,注意,必须,可以,如果,然后,并且,以及,关于,根据,通过,这些,那些,什么,怎么,如何').split(','),
)

export function tokenize(text) {
  const s = String(text || '').toLowerCase()
  const out = []
  const re = /[a-z0-9][a-z0-9._-]*|[\u4e00-\u9fff]+/g
  let m
  while ((m = re.exec(s)) !== null) {
    const chunk = m[0]
    if (/^[a-z0-9]/.test(chunk)) {
      if (chunk.length >= 2 && chunk.length <= 32) out.push(chunk)
      continue
    }
    if (chunk.length === 1) {
      if (!STOP.has(chunk)) out.push(chunk)
      continue
    }
    for (let i = 0; i + 1 < chunk.length; i += 1) {
      const gram = chunk.slice(i, i + 2)
      if (!STOP.has(gram)) out.push(gram)
    }
  }
  return Array.from(new Set(out))
}

// Weighted overlap scoring against an inverted index of flat [id, weight, id, weight, …] postings.
function searchIndex(index, query, limit) {
  const marks = index.marks
  const scores = index.scores
  index.gen += 1
  const gen = index.gen
  const candidates = []
  for (const term of tokenize(query)) {
    const post = index.inv[term]
    if (post === undefined) continue
    for (let i = 0; i < post.length; i += 2) {
      const id = post[i]
      if (marks[id] !== gen) {
        marks[id] = gen
        scores[id] = 0
        candidates.push(id)
      }
      scores[id] += post[i + 1]
    }
  }
  candidates.sort((a, b) => scores[b] - scores[a])
  return candidates.slice(0, limit).map((id) => ({ id, score: scores[id] }))
}

// A skills file shorter than this many CJK characters is treated as a stub and skipped.
// Default is low on purpose: a 200-character runbook is still a usable expert instruction, and
// silently dropping a file the user deliberately placed in the folder is worse than indexing a
// near-duplicate. The previous default of 500 discarded 21 of the 30 real skills in a live folder.
export const SKILLS_MIN_CJK = Number(process.env.ZH_PROMPT_SKILLS_MIN_CJK) || 150
// Upper bound on how much of one skills file is injected into the model. Real expert skills run
// 200–4000 CJK characters, so this only ever fires on an oversized file; without it a single
// large document could crowd out the whole context window.
const SKILLS_MAX_CHARS = Number(process.env.ZH_PROMPT_SKILLS_MAX_CHARS) || 8000

export function createZhRetriever(options) {
  const { corpusPaths, skillsDir, readFirst } = options
  const minCjk = Number(options.minCjk) || SKILLS_MIN_CJK
  const maxChars = Number(options.maxChars) || SKILLS_MAX_CHARS
  let corpus = null
  let loadingCorpus = null
  let skills = null
  let loadingSkills = null
  let skipped = []

  async function ensureCorpus() {
    if (corpus) return corpus
    if (!loadingCorpus) {
      loadingCorpus = readFirst('zh-corpus.json')
        .then((raw) => {
          const data = JSON.parse(raw)
          corpus = {
            docs: data.docs || [],
            inv: data.inv || {},
            generalCount: data.generalCount || 0,
            marks: new Int32Array((data.docs || []).length).fill(-1),
            scores: new Float64Array((data.docs || []).length),
            gen: 0,
          }
          loadingCorpus = null
          return corpus
        })
        .catch((error) => {
          loadingCorpus = null
          throw error
        })
    }
    return loadingCorpus
  }

  // Local expert skills are read live from disk: the user edits them, so an embedded snapshot
  // would silently go stale. Token sets are computed once and cached in memory.
  async function ensureSkills() {
    if (skills) return skills
    if (!loadingSkills) {
      loadingSkills = (async () => {
        const found = []
        const tooShort = []
        let names = []
        try {
          names = await readdir(skillsDir)
        } catch (error) {
          names = []
        }
        for (const name of names) {
          if (!name.endsWith('.md')) continue
          try {
            const text = await readFile(join(skillsDir, name), 'utf8')
            const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length
            if (cjk < minCjk) {
              // Recorded, not just dropped: a file the user placed here and that never matches
              // is the single most confusing failure mode of this rail.
              tooShort.push({ name, cjk })
              continue
            }
            found.push({
              name,
              text,
              cjk,
              terms: new Set(tokenize(text.slice(0, maxChars))),
            })
          } catch (error) {
            /* unreadable file: skip */
          }
        }
        skipped = tooShort
        skills = found
        loadingSkills = null
        return skills
      })().catch((error) => {
        loadingSkills = null
        skills = []
        return skills
      })
    }
    return loadingSkills
  }

  // What actually goes to the model: capped, with an honest marker so the reader knows it is cut.
  function injectable(skill) {
    if (skill.text.length <= maxChars) return skill.text
    return skill.text.slice(0, maxChars) + `\n\n…（原文共 ${skill.text.length} 字，此处截断至 ${maxChars} 字；需要全文请用 get_chinese_prompt_doc 取回）`
  }

  return {
    async warmup() {
      const c = await ensureCorpus()
      const s = await ensureSkills()
      return { docs: c.docs.length, general: c.generalCount, skills: s.length, skipped }
    },

    /**
     * @returns {{ snippets: {text,label,source,score}[], matched: string[], stats: object }}
     */
    async retrieve(query, limit) {
      const corpusIndex = await ensureCorpus()
      const localSkills = await ensureSkills()
      const terms = tokenize(query)
      // A fixed "4 matching terms" floor is unreachable for short queries: CJK 2-gram tokenization
      // means "膜清洗" produces three overlapping bigrams (膜清/清洗/洗方) of which a document
      // typically contains two, so "写一个 MBR 膜清洗方案" scored 3 and silently missed the very
      // document that covers MBR. Scale the floor with query length instead.
      const minMatch = Math.min(4, Math.max(2, Math.ceil(terms.length / 2)))
      const picked = []

      // 1) local expert skills — weighted highest, injected in full so the expert logic survives.
      const skillScored = localSkills
        .map((skill) => {
          let score = 0
          const hits = []
          for (const term of terms) {
            if (skill.terms.has(term)) {
              score += 1
              hits.push(term)
            }
          }
          return { skill, score, hits }
        })
        .filter((row) => row.score >= minMatch)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
      for (const row of skillScored) {
        picked.push({
          source: 'skill',
          label: `本地专家：${row.skill.name}（命中 ${row.score} 词）`,
          score: row.score * 1.3,
          // Skills are hand-written expert logic and truncating them mid-instruction loses exactly
          // the part that makes them valuable — but an unbounded file would crowd out the request
          // itself, so injectable() caps it and says so in the text.
          path: join(skillsDir, row.skill.name),
          text: injectable(row.skill),
          fullText: row.skill.text,
        })
      }

      // 2) Chinese corpus (general prompts + task skeletons).
      if (corpusIndex.docs.length > 0) {
        for (const hit of searchIndex(corpusIndex, query, 4)) {
          if (hit.score < minMatch) continue
          const doc = corpusIndex.docs[hit.id]
          const isTemplate = doc[1] === 'template'
          picked.push({
            source: isTemplate ? 'template' : 'general',
            label: isTemplate ? `任务骨架：${doc[2]}` : `中文提示词样例${doc[2] ? '（' + doc[2] + '）' : ''}`,
            score: hit.score * (isTemplate ? 0.85 : 1),
            text: String(doc[0]).slice(0, 1400),
          })
        }
      }

      picked.sort((a, b) => b.score - a.score)
      const top = picked.slice(0, limit || 4)

      // 3) If a task skeleton matched, surface every skeleton of that kind as a shape reference.
      const templateKinds = new Set(top.filter((p) => p.source === 'template').map((p) => p.label.replace('任务骨架：', '')))
      if (templateKinds.size > 0) {
        for (const doc of corpusIndex.docs) {
          if (doc[1] !== 'template' || !templateKinds.has(doc[2])) continue
          if (top.some((t) => t.source === 'template' && t.label === `任务骨架：${doc[2]}`)) continue
          top.push({ source: 'template', label: `任务骨架：${doc[2]}`, score: 1, text: String(doc[0]).slice(0, 600) })
        }
      }

      return {
        snippets: top,
        matched: top.map((t) => t.label),
        stats: {
          terms: terms.length,
          // Counts what actually reached the caller for THIS query, not how many files exist on
          // disk: reporting "1 local expert doc" while injecting none reads as a contradiction.
          skills: top.filter((t) => t.source === 'skill').length,
          skillsLoaded: localSkills.length,
          corpusDocs: corpusIndex.docs.length,
          general: corpusIndex.generalCount,
        },
      }
    },
  }
}
