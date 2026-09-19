// dsh-prompt-enhancer — host half.
//
// 职能：
//   GET  /dsh-prompt-enhancer/match-index.json   兼容用：直接下发检索索引
//   POST /dsh-prompt-enhancer/enhance            收草稿 → 检索 → 改写 → 返回结果
//
// 检索为什么放在宿主半（而不是浏览器半）：
//   中文输入的字对不上英文模板标题，所以检索前要先做一步「意图翻译」把需求转成英文
//   检索词。那一步必须调模型，而模型只在宿主半可用；既然翻译在这里，检索也放这里，
//   浏览器半就只负责「传草稿、拿结果、回写」，不再背着 1.5MB 索引，逻辑也不会两边各一份。
//
// 四条踩过的规矩（每条都是真实故障换来的）：
//   A. apply() 必须同步完成所有注册。写成 async 会让宿主半被判定“已加载”而注册尚未完成，
//      客户端一调就是 not registered。
//   B. 取服务一律 ctx.get('name') + 判空，不要写 ctx.<name> —— 后者要求已注入，
//      拿不到注入的环境里会直接抛错。
//   C. 每一处注册都必须单独 try/catch。本插件随 DSH 启动加载，任何一处抛出都会让
//      整棵插件树加载失败、把 GUI 锁进恢复模式（0.1.0 就是这么崩的）。
//   D. 不要用 connection 的 RPC 通道：其 rpc.handle 内部依赖 webServer 注入，
//      在非标准上下文里会抛 “cannot get property webServer without inject”。

import { readFile, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createZhRetriever } from './zhretriever.js'

export const name = 'dsh-prompt-enhancer'
export const inject = ['fs', 'llm', 'webServer']

const HERE = dirname(fileURLToPath(import.meta.url))

// 发布版必须能脱离作者机器运行。私人路径一律改成"自动探测 + 可选覆盖 + 缺目录不报错"：
//
//   skillsDir   用户的本地专家语料目录。默认按 DSH_HOME / 用户主目录推算；探测不到就
//               退化为"只用随包语料"，功能不缺失、也不抛错。
//   extraDataDirs  额外数据目录（开发期方便指向工作区）。默认空。
//
// 覆盖方式：在插件目录放一个 config.json（见 README「配置」一节），或直接改下面两个
// 环境变量。刻意不引入 schemastery —— 实测 ctx.config 在插件上下文里不可读，
// 加一个读了也没有的依赖不如不加。
function defaultSkillsDir() {
  const home = process.env.DSH_HOME
  if (home) return join(home, 'skills')
  const userHome = process.env.USERPROFILE || process.env.HOME
  return userHome ? join(userHome, '.dsh', 'skills') : ''
}

function loadLocalConfig() {
  try {
    const raw = readFileSync(join(HERE, 'config.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    return {}
  }
}

const LOCAL_CONFIG = loadLocalConfig()
const ASSET_PATH = '/dsh-prompt-enhancer/match-index.json'
const ENHANCE_PATH = '/dsh-prompt-enhancer/enhance'
const SKILLS_DIR = String(LOCAL_CONFIG.skillsDir || process.env.DSH_PROMPT_ENHANCER_SKILLS || defaultSkillsDir() || '')

const DATA_DIRS = [HERE].concat(Array.isArray(LOCAL_CONFIG.extraDataDirs) ? LOCAL_CONFIG.extraDataDirs : [])
const ZH_CORPUS_DIRS = [HERE]

const KEYWORD_SYSTEM = [
  'You convert a user request (any language) into English search keywords for a prompt-template library.',
  'Output ONE line only: 8-16 lowercase English keywords or short phrases, space separated.',
  'Include the task type (e.g. article writing, code review, data analysis), the domain',
  '(e.g. water treatment, marketing), the role to act as, and the output format.',
  'Do not output sentences, punctuation (except spaces), explanations, or the original language.',
].join('\n')

const SYSTEM_PROMPT = [
  '你是顶级提示词工程师（prompt engineer）。你的唯一任务是把用户的一句话需求，改写成一条可直接投喂给大模型的高质量提示词。',
  '',
  '硬性要求：',
  '1. 只输出改写后的提示词正文。不要解释、不要客套、不要用代码块包裹、不要输出“以下是优化后的提示词”之类的话。',
  '2. 语言与用户输入的语言保持一致（用户用中文就用中文，用户用英文就用英文）。',
  '3. 完整保留用户的原意与关键信息，不得改变需求、不得编造用户没提过的事实。',
  '4. 补齐高质量提示词应有的要素：角色设定（Act as…）、清晰任务、背景/输入、约束与边界、输出格式与结构、质量标准；信息不足时用【待补充：…】占位，不要瞎编。',
  '5. 结构化、可直接执行，长度控制在 150–450 字（英文 100–300 词）；不要空话套话。',
  '6. 「检索意图关键词」是上一步用英语写的意图摘要，仅用于把握意图与结构；输出请用用户语言。',
  '7. 若提供了参考模板，只借鉴其结构与专业表述，不要把模板的示例内容照搬进结果。',
].join('\n')

// 回退链：会话默认模型可能是配额耗尽/上游不可用的路由
// （实测 group-ai/deepseek-v4-pro 会以 “Connection error.” 在 20ms 内失败），
// 绝不允许把第一条路由的错误直接抛给用户。失败过的路由进 5 分钟熔断。
const FALLBACK_ROUTES = [
  { provider: 'deepseek-official', model: 'deepseek-flash' },
  { provider: 'deepseek-official', model: 'deepseek-chat' },
]
const COOLDOWN_MS = 5 * 60 * 1000

// 关键词提取单独指定模型顺序，**不跟随会话默认模型**：
// 默认路由可能是坏掉的（本机配置里的 group-ai 就是），跟随它只会白白多一次失败。
// 实测产出率（各跑 3 次）：
//   deepseek-flash   + 现有提示词 + 1200 预算 → 3/3，平均 3.0s   ← 采用
//   deepseek-v4-flash+ “关键词打头”提示词 + 1200 → 3/3，平均 3.1s ← 备选
//   deepseek-v4-pro  + 300 预算              → 2/3，且有 15s 超时  ← 不用
const KEYWORD_ROUTES = [
  { provider: 'deepseek-official', model: 'deepseek-flash' },
  { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
]

const STOP = new Set(
  ('the,and,for,that,this,with,you,are,can,how,what,when,where,which,who,why,will,would,have,has,had,not,but,from,they,them,then,just,like,make,more,some,than,very,also,into,act,acts,as,a,an,to,of,in,is,it,on,be,do,so,me,my,we,our,your,its,all,was,been,one,want,please,help,need,use,using,give,tell,show,write,create,get,know,think,say,thing,way,well,much,go,going,should,could,must,may,might,about,over,under,after,before,between,out,up,down,off,only,own,same,such,no,nor,too,any,each,few,most,other,there,these,those,through,while,without').split(',')
)

function tokenize(text) {
  if (!text) return []
  const s = String(text).toLowerCase()
  const out = []
  const re = /[a-z0-9]+|[\u4e00-\u9fff]+/g
  let m
  while ((m = re.exec(s)) !== null) {
    const w = m[0]
    if (/^[a-z0-9]+$/.test(w)) {
      if (w.length >= 2 && w.length <= 24 && !STOP.has(w)) out.push(w)
    } else if (w.length === 1) out.push(w)
    else {
      for (let i = 0; i < w.length; i++) {
        out.push(w[i])
        if (i + 1 < w.length) out.push(w.slice(i, i + 2))
      }
    }
  }
  return Array.from(new Set(out))
}

function clip(text, limit) {
  const value = String(text == null ? '' : text)
  return value.length > limit ? value.slice(0, limit) + '\n…（截断）' : value
}

function stripFence(text) {
  let value = String(text || '').trim()
  if (value.startsWith('```')) {
    const nl = value.indexOf('\n')
    if (nl !== -1) value = value.slice(nl + 1)
    const end = value.lastIndexOf('```')
    if (end !== -1) value = value.slice(0, end)
  }
  return value.trim()
}

// 非 ASCII 占比高才值得翻译；纯英文草稿直接检索。
function needsTranslation(text) {
  if (!text) return false
  let nonAscii = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) nonAscii += 1
  return nonAscii / text.length > 0.05
}

// 正文流被推理吃光时的兜底：推理末尾往往已经列出答案
// （实测尾部形如 “write1 article2 wechat3 official4 account5 ai6 impact7 water8 treatment9 …”）。
// 把所有英文词按出现顺序摊平，过滤掉纯数字与前缀词，取前 24 个即可作为检索词。
function salvageFromReasoning(reasoning) {
  const words = String(reasoning || '')
    .toLowerCase()
    .match(/[a-z]{2,}/g)
  if (!words || words.length === 0) return ''
  const drop = new Set(['count', 'keyword', 'keywords', 'total', 'need', 'final', 'output', 'one', 'line', 'only', 'lowercase', 'punctuation', 'good', 'fine', 'include', 'ensure', 'format', 'okay', 'then', 'that', 'this', 'with', 'from'])
  const picked = []
  const seen = new Set()
  for (const word of words) {
    if (drop.has(word) || seen.has(word)) continue
    seen.add(word)
    picked.push(word)
    if (picked.length >= 24) break
  }
  return picked.length >= 4 ? picked.join(' ') : ''
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function apply(ctx) {
  const health = { asset: 'pending', enhance: 'pending', zh: 'pending' }

  const fs = ctx.get('fs')
  const webServer = ctx.get('webServer')
  const llm = ctx.get('llm')
  const modelSelector = ctx.get('agentDefaultModel')
  const timer = ctx.get('timer')

  const routeCooldown = new Map()
  let library = null
  let loadingLibrary = null
  let matchIndex = null
  let loadingMatchIndex = null
  let zhRetriever = null

  async function readFirst(fileName) {
    const failures = []
    for (const dir of DATA_DIRS) {
      try {
        return await readFile(join(dir, fileName), 'utf8')
      } catch (error) {
        failures.push(dir + ' → ' + String((error && error.code) || error))
      }
    }
    throw new Error('找不到 ' + fileName + '，已尝试：\n' + failures.join('\n'))
  }

  // 中文轨单独构造，构造过程不读盘也不注册任何东西，因此不会影响插件树加载。
  try {
    zhRetriever = createZhRetriever({
      corpusPaths: ZH_CORPUS_DIRS,
      skillsDir: SKILLS_DIR,
      readFirst: async (name) => {
        const failures = []
        for (const dir of ZH_CORPUS_DIRS) {
          try {
            return await readFile(join(dir, name), 'utf8')
          } catch (error) {
            failures.push(dir + ' → ' + String((error && error.code) || error))
          }
        }
        throw new Error('找不到 ' + name + '，已尝试：\n' + failures.join('\n'))
      },
    })
    health.zh = 'ready'
  } catch (error) {
    health.zh = 'failed: ' + String((error && error.message) || error)
  }

  function ensureLibrary() {
    if (library) return Promise.resolve(library)
    if (!loadingLibrary) {
      loadingLibrary = readFirst('prompt-library.json')
        .then((raw) => {
          library = JSON.parse(raw).docs || []
          loadingLibrary = null
          return library
        })
        .catch((error) => {
          loadingLibrary = null
          throw error
        })
    }
    return loadingLibrary
  }

  function ensureMatchIndex() {
    if (matchIndex) return Promise.resolve(matchIndex)
    if (!loadingMatchIndex) {
      loadingMatchIndex = readFirst('match-index.json')
        .then((raw) => {
          const data = JSON.parse(raw)
          const docs = data.docs || []
          matchIndex = {
            docs,
            inv: data.inv || {},
            mark: new Int32Array(docs.length).fill(-1),
            score: new Float64Array(docs.length),
            gen: 0,
          }
          loadingMatchIndex = null
          return matchIndex
        })
        .catch((error) => {
          loadingMatchIndex = null
          throw error
        })
    }
    return loadingMatchIndex
  }

  function search(query, limit) {
    matchIndex.gen += 1
    const gen = matchIndex.gen
    const cand = []
    for (const term of tokenize(query)) {
      const post = matchIndex.inv[term]
      if (post === undefined) continue
      for (let i = 0; i < post.length; i += 2) {
        const id = post[i]
        if (matchIndex.mark[id] !== gen) {
          matchIndex.mark[id] = gen
          matchIndex.score[id] = 0
          cand.push(id)
        }
        matchIndex.score[id] += post[i + 1]
      }
    }
    cand.sort((a, b) => matchIndex.score[b] - matchIndex.score[a])
    return cand.slice(0, limit).map((id) => ({ index: id, score: matchIndex.score[id] }))
  }

  function pickModel() {
    try {
      if (modelSelector && typeof modelSelector.currentSelection === 'function') {
        const selection = modelSelector.currentSelection()
        if (selection && selection.provider && selection.model) {
          return { provider: String(selection.provider), model: String(selection.model) }
        }
      }
    } catch (error) {
      /* 配置不可读时退回官方路由 */
    }
    return { provider: 'deepseek-official', model: 'deepseek-flash' }
  }

  function routeCandidates() {
    const out = [pickModel()]
    for (const fallback of FALLBACK_ROUTES) {
      if (!out.some((r) => r.provider === fallback.provider && r.model === fallback.model)) out.push(fallback)
    }
    const now = Date.now()
    const healthy = out.filter((route) => {
      const until = routeCooldown.get(route.provider + '/' + route.model)
      return until === undefined || until <= now
    })
    return healthy.length > 0 ? healthy : out
  }

  async function callModel(system, userText, maxTokens, effort, preferredRoutes) {
    const failures = []
    const base = preferredRoutes && preferredRoutes.length > 0 ? preferredRoutes : routeCandidates()
    // 仍然按熔断过滤，但若全在冷却中也照试，避免无路可走。
    const now = Date.now()
    const filtered = base.filter((route) => {
      const until = routeCooldown.get(route.provider + '/' + route.model)
      return until === undefined || until <= now
    })
    const routes = filtered.length > 0 ? filtered : base
    for (const route of routes) {
      const key = route.provider + '/' + route.model
      // 同一路由最多试两次，且第二次抬高 token 预算。
      // 实测推理模型偶发「正文为空」（推理把预算吃光），重试一次成功率明显更高；
      // 直接换路由会白白多花一次首字延迟。
      let lastFailure = null
      let salvageFallback = ''
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const budget = attempt === 0 ? maxTokens : Math.round(maxTokens * 1.75)
        const controller = new AbortController()
        let cancel = null
        if (timer && typeof timer.timeout === 'function') {
          cancel = timer.timeout(() => controller.abort(), 60000)
        }
        let out = ''
        let reasoning = ''
        let failure = null
        try {
          const options = {
            provider: route.provider,
            model: route.model,
            system,
            messages: [
              {
                id: 'prompt-enhancer-1',
                role: 'user',
                content: [{ type: 'text', text: userText }],
                source: { kind: 'plugin', plugin: 'prompt-enhancer' },
              },
            ],
            temperature: 0.3,
            maxTokens: budget,
            signal: controller.signal,
          }
          // 默认压低推理档：推理 token 与正文 token 共享 maxTokens，不压低就会把正文饿死
          // （实测默认档下 400 token 全被推理吃光、正文 0 字）。keyword 步骤已经显式传 'low'。
          options.reasoningEffort = effort || 'low'
          for await (const chunk of llm.stream(options)) {
            if (chunk && chunk.type === 'text-delta') out += chunk.text || ''
            else if (chunk && chunk.type === 'reasoning-delta') reasoning += chunk.text || ''
            else if (chunk && chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
              failure = (chunk.reason.failure && chunk.reason.failure.message) || '模型返回错误'
            }
          }
        } catch (error) {
          failure = String((error && error.message) || error)
        } finally {
          if (cancel) cancel()
        }

        const text = stripFence(out)
        if (text) {
          routeCooldown.delete(key)
          return { ok: true, text, route: key + (attempt > 0 ? ' (retry)' : ''), failures, fromReasoning: false }
        }
        // 推理兜底只在**本路由两次尝试都失败后**才采用。
        // 曾经把它放在第一次尝试之后就 return，结果把推理流里的自言自语
        // （形如 "we answer in chinese rewritten prompt role task …"）当成正文，
        // 既跳过了本可成功的重试，又把垃圾喂给下一步生成 —— 这是真实故障。
        const salvage = salvageFromReasoning(reasoning)
        if (salvage) salvageFallback = salvage
        lastFailure = failure || '空回复'
      }
      if (salvageFallback) {
        routeCooldown.delete(key)
        return { ok: true, text: salvageFallback, route: key + ' (salvage)', failures, fromReasoning: true }
      }
      routeCooldown.set(key, Date.now() + COOLDOWN_MS)
      failures.push(key + '：' + lastFailure)
    }
    return { ok: false, failures }
  }

  async function runEnhance(text) {
    const draft = String(text || '').trim()
    if (!draft) return { ok: false, error: '输入框是空的' }
    if (!llm) return { ok: false, error: 'llm 服务不可用' }

    const started = Date.now()
    const failures = []
    let keywords = ''
    let skippedTranslate = false
    let searchMs = 0
    let titles = []
    let reference = ''

    try {
      await ensureMatchIndex()

      // 第一步：非英文草稿先转成英文检索词。
      // 注意：推理模型的 maxTokens 是推理与正文共享的 —— 给小预算不会让输出更短，
      // 而是让正文直接为空。实测 budget 400 → 0 字符，1200 → 113 字符，2000 → 123 字符，
      // 所以这里用 1200 并配 reasoningEffort 'low'（'minimal' 会被 deepseek-flash 拒绝）。
      if (needsTranslation(draft)) {
        const kw = await callModel(KEYWORD_SYSTEM, draft, 1200, 'low', KEYWORD_ROUTES)
        if (kw.ok) keywords = kw.text.replace(/[^a-zA-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
        else failures.push(...kw.failures)
      } else {
        skippedTranslate = true
      }

      // 第二步：双轨检索。
      //   中文轨 —— 本地专家 skill + 中文提示词语料 + 任务骨架。这条轨才是中文需求真正对口的来源：
      //            英文库（2,306 条、95% 英文）里没有水厂/公众号/法律这类中文垂直内容。
      //   英文轨 —— 仅在「意图翻译出了检索词」时有意义，作为通用补充。
      const tSearch = Date.now()
      const zh = await zhRetriever.retrieve(draft, 4)
      let zhBlock = ''
      const zhTitles = []
      if (zh.snippets.length > 0) {
        const parts = []
        for (const snippet of zh.snippets) {
          let body = snippet.text
          // Local expert skills are injected in full: they are hand-written expert logic and
          // truncating them mid-instruction loses the part that carries the expertise.
          if (snippet.path) {
            try {
              body = await readFile(snippet.path, 'utf8')
            } catch (error) {
              /* fall back to the cached copy */
            }
          }
          parts.push('【' + snippet.label + '】\n' + clip(body, snippet.path ? 6000 : 1400))
          zhTitles.push(snippet.label)
        }
        zhBlock = '\n\n以下是该领域的参考材料（学习其专业表述、判断逻辑与交付标准；不要照搬其中的具体项目名、数值或案例）：\n\n' + parts.join('\n\n---\n\n')
      }

      let templates = []
      if (keywords) {
        for (const hit of search(query, 3)) {
          if (hit.score < 3) continue
          const docs = await ensureLibrary().catch(() => [])
          const doc = docs[hit.index]
          if (doc && doc.content) templates.push(doc)
        }
      }
      searchMs = Date.now() - tSearch

      titles = zhTitles.concat(templates.map((doc) => doc.title || ''))
      if (templates.length > 0) {
        reference =
          zhBlock +
          '\n\n另可参考的通用模板（仅供结构参考）：\n\n' +
          templates
            .map((doc, index) => {
              const category = doc.category ? '｜' + doc.category : ''
              return '【通用' + (index + 1) + category + '】' + (doc.title || '') + '\n' + clip(doc.content, 1200)
            })
            .join('\n\n---\n\n')
      } else {
        reference = zhBlock
      }
    } catch (error) {
      failures.push('检索阶段：' + String((error && error.message) || error))
    }

    // 第三步：用原语言输出。
    const intent = keywords ? '\n\n检索意图关键词（英语，仅用于理解意图，输出请用用户语言）：\n' + keywords : ''
    const userText = '用户原始输入：\n' + clip(draft, 2000) + intent + reference + '\n\n请输出改写后的提示词正文。'
    const gen = await callModel(SYSTEM_PROMPT, userText, 1600, null)
    if (!gen.ok) {
      return { ok: false, error: '所有模型路由都失败：' + gen.failures.join(' ｜ '), keywords, failures, ms: Date.now() - started }
    }

    return {
      ok: true,
      enhanced: clip(gen.text, 8000),
      keywords,
      matched: titles,
      usedTemplates: titles.length,
      usedRoute: gen.route,
      failures: failures.concat(gen.failures),
      searchMs,
      skippedTranslate,
      ms: Date.now() - started,
    }
  }

  // ── 1) 兼容路由：仍然可以直接取检索索引 ────────────────────────────────────
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: ASSET_PATH,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.statusCode = 405
              res.end()
              return Promise.resolve()
            }
            return readFirst('match-index.json')
              .then((body) => {
                res.statusCode = 200
                res.setHeader('content-type', 'application/json; charset=utf-8')
                res.setHeader('cache-control', 'no-store')
                res.end(body)
              })
              .catch((error) => sendJson(res, 500, { ok: false, error: String((error && error.message) || error) }))
          },
        }),
      'prompt-enhancer: match index asset'
    )
    health.asset = 'registered'
  } catch (error) {
    health.asset = 'failed: ' + String((error && error.message) || error)
  }

  // ── 2) 改写端点：收 { text }，返回结果 ─────────────────────────────────────
  try {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: ENHANCE_PATH,
          handler: (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return Promise.resolve()
            }
            return readBody(req, 512 * 1024)
              .then((raw) => {
                let args = {}
                try {
                  args = JSON.parse(raw || '{}')
                } catch (error) {
                  args = {}
                }
                return runEnhance(args.text)
              })
              .then((result) => sendJson(res, 200, result))
              .catch((error) => sendJson(res, 200, { ok: false, error: String((error && error.message) || error) }))
          },
        }),
      'prompt-enhancer: enhance endpoint'
    )
    health.enhance = 'registered'
  } catch (error) {
    health.enhance = 'failed: ' + String((error && error.message) || error)
  }

  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('promptEnhancerHealth', health)
    } catch (error) {
      /* 排障信息拿不到就算了 */
    }
  }
}
