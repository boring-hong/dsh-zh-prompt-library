// 给 zh-corpus.json 增补调研蒸馏出的高频中文场景骨架，并重建倒排索引。
// 用法: node scripts/add-corpus.mjs   （在插件仓库根目录运行，写回 lib/zh-corpus.json）
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = join(HERE, '..', 'lib', 'zh-corpus.json')

const STOP = new Set(
  ('的,了,和,是,在,我,有,就,不,人,都,一,一个,上,也,很,到,说,要,去,你,会,着,没有,看,好,自己,这,那,他,她,它,们,与,及,或,请,帮,把,被,给,让,用,对,从,为,以,等,可,能,将,需要,进行,以下,下面,如下,要求,任务,内容,注意,必须,可以,如果,然后,并且,以及,关于,根据,通过,这些,那些,什么,怎么,如何').split(',')
)

function tokenize(text) {
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

// ---- 调研蒸馏的 16 个高频中文场景骨架 ----
// 结构：[text, source, label, title, weight]
const NEW_DOCS = [
  ['你是资深的公众号长文作者，深耕【领域】，为读者画像【受众】写一篇公众号深度长文。\n结构：一个真实场景或反常识断言开头，正文 3-5 个干货点（每个点配一个数字、案例或可操作清单），结尾一句收束不升华。\n字数 2000-3000 字。语气像【人设】在复盘，不说教、不排比。\n数据只能来自我提供的材料，材料里没有的写「需核实」，禁止编造。', 'template', 'GzhLongform', '公众号长文骨架', '900'],
  ['你是熟悉小红书生态的内容策划。写一篇种草笔记。\n结构：emoji 标题 + 1-2 句钩子开头 + 每段 2-3 句的短段正文 + 3 条小贴士 + 行动召唤 + 5-10 个话题标签。\n字数 300-800。口语化、有画面感，禁用「家人们谁懂」等烂梗开头。\n产品参数只能用我提供的，没提供的留【待补充】。', 'template', 'XhsNote', '小红书种草笔记骨架', '900'],
  ['你是高赞知乎答主。就【问题】写一篇回答。\n结构：先给结论（1-2 句）→ 论证（每条论点配数据或案例，数据注明来源与时间）→ 分点小结 → 一句关注引导。\n字数 1000-2000。语气克制、敢下判断；查不到的数据写「未找到」而不是猜。', 'template', 'ZhihuAnswer', '知乎回答骨架', '900'],
  ['你是短视频口播编剧。写一支抖音口播稿。\n结构：【开头 3 秒钩子】（一句反差或悬念）→【正文】口语化推进，每 15 秒一个信息点 →【结尾 CTA】。\n字数 200-500（约 30-90 秒口播）。全部短句，读一遍确保顺口，不出现书面语。', 'template', 'DouyinScript', '抖音口播稿骨架', '900'],
  ['你是职场写作教练。帮我写本周周报。\n结构：本周完成（按项目分组，写结果与数字，不写过程）→ 问题与需要的支持 → 下周计划（可验证的节点）。\n规矩：数字只能来自我的记录，没有的不补；不超过一屏。', 'template', 'WeeklyReport', '工作周报骨架', '900'],
  ['你是专业会议纪要撰写人。根据我提供的会议记录产出纪要。\n结构：主题 / 结论（编号列出）/ 待办表（事项、负责人、截止）/ 未决问题。\n规矩：我没写的信息标「待确认」，禁止替与会者补充观点；负责人为空时标「待定」。', 'template', 'MeetingMinutes', '会议纪要骨架', '900'],
  ['你是沟通教练。帮我回复一封棘手的邮件。\n流程：先用两句话分析对方真正在意什么（利益/面子/风险），再给两个版本：委婉版与直接版，各不超过 200 字。\n背景：【待补充：邮件原文与你的立场】。两个版本都要给对方一个体面的台阶。', 'template', 'TrickyEmail', '棘手邮件回复骨架', '900'],
  ['你是竞品分析师。对【产品A】与【产品B】做对比分析，使用联网检索获取最新信息。\n输出：四维度对比表（每个维度一行：功能/价格/口碑/适用场景），每条结论后附来源链接与查询时间。\n规矩：查不到的信息写「未找到」，不推测；最后给一句选型建议（说明适用前提）。', 'template', 'CompetitorCompare', '竞品对比骨架', '900'],
  ['你是数据分析专家。分析我提供的表格数据。\n流程：先检查缺失值与异常值并列出（不急着答题），确认口径后再回答问题。\n规矩：每个结论写出依据数字与计算方法；单位与时间范围必须与原始数据一致；发现口径矛盾时先指出再回答。', 'template', 'TableAnalysis', '表格数据分析骨架', '900'],
  ['你是合同审查助手。从长文档中提取要点。\n输出：核心要点不超过 7 条；涉及金额、日期、义务的条款逐条列出并标注页码；单独一节列「对我方不利项」。\n规矩：不确定的条款标「建议人工核对」，禁止给法律意见；原文未出现的条款不得列入。', 'template', 'DocExtract', '长文档要点提取骨架', '900'],
  ['你是耐心的入门导师。带我快速了解【陌生领域】。\n输出：10 个核心概念（每个一句话定义 + 一个生活化类比）、3 个新手常见误区、下一步学习路径（按顺序 3 步）。\n类比必须日常化（做菜/开车/逛街级别的），不用行话解释行话。', 'template', 'DomainOnboarding', '陌生领域快速入门骨架', '900'],
  ['你是资深面试官，招聘岗位【岗位】。模拟一场面试。\n流程：按 JD 出 3 道题（1 道基础 + 1 道场景 + 1 道追问压力题）→ 我作答 → 逐题给评分（1-5）与改进点 → 三轮后给总体评价。\n规矩：追问要针对我答案里的具体漏洞，不问教科书问题。', 'template', 'InterviewSim', '面试模拟官骨架', '900'],
  ['你是 SQL 专家。根据表结构与需求生成 SQL。\n流程：先用一句话解释查询逻辑，再给 SQL，最后说明索引建议与潜在性能坑。\n规矩：字段名只使用我提供的表结构里存在的；JOIN 条件必须显式；输出外层包一句注释说明业务含义。', 'template', 'SqlGen', 'SQL 生成骨架', '900'],
  ['你是代码重构顾问。审查我提供的代码并给重构方案。\n输出三节：现状问题（具体到行，不复述代码）/ 重构方案（先讲思路再给代码）/ 权衡（什么场景不该这么改）。\n规矩：行为保持不变的前提下谈结构；不引入我没在用的依赖。', 'template', 'CodeRefactor', '代码重构骨架', '900'],
  ['你是故障排查工程师。针对【设备/系统/工艺】的【异常现象】输出排查方案。\n结构：故障树式排查清单（按「先易后难、先仪表后工艺」排序，每步给出：检查什么 / 正常标准 / 异常时的处置）→ 处置参数表（参数、正常范围、调整方向）。\n规矩：参数只能来自我提供的资料；没有依据的处置写「需现场确认」，禁止编造数值。', 'template', 'TroubleshootTree', '故障树排查骨架', '900'],
  ['你是政府机关笔杆子。起草一份【文种】。\n结构：背景（2-3 句，交代依据）→ 事项（分条，每条一个动词开头）→ 要求（落实单位与时限）。\n语气庄重克制，短句为主，禁用网络词与感叹号；涉及数字与单位名称以我提供的为准。', 'template', 'GovDoc', '公文体骨架', '900'],
]

const data = JSON.parse(readFileSync(CORPUS, 'utf8'))

// 去重：按 label 判重，已有同 label 的先删（本脚本可重复运行）
const existingLabels = new Set(data.docs.map((d) => d[2]))
const kept = data.docs.filter((d) => !NEW_DOCS.some((n) => n[2] === d[2]))
const added = NEW_DOCS.filter((n) => !existingLabels.has(n[2]))
const docs = kept.concat(added)

// 重建倒排索引：term -> flat [docId, weight, ...]
// weight = 词在 doc 文本中出现的次数（简单词频，与 firefly 原索引语义一致）
const inv = {}
docs.forEach((doc, id) => {
  const terms = tokenize(doc[0])
  const count = new Map()
  for (const t of terms) count.set(t, (count.get(t) || 0) + 1)
  for (const [t, c] of count) {
    if (!inv[t]) inv[t] = []
    inv[t].push(id, c)
  }
})

const out = {
  v: 1,
  n: docs.length,
  generalCount: docs.filter((d) => d[1] === 'general').length,
  tokens: Object.keys(inv).length,
  docs,
  inv,
}
writeFileSync(CORPUS, JSON.stringify(out))
console.log(`docs: ${data.docs.length} -> ${docs.length} (added ${added.length})`)
console.log(`inv terms: ${Object.keys(inv).length}`)
console.log('added labels:', added.map((a) => a[2]).join(', '))
