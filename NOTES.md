# 开发与排障记录（内部）

> 这份是给维护者看的：每条约束都是**真实崩溃/实测数据**换来的，改动前请先读完。
> 面向使用者的说明在 [`README.md`](README.md)。

## 一、三条硬约束

1. **`apply()` 必须同步完成所有注册。** 写成 `async apply` 会让宿主半被判定"已加载"而注册尚未完成，
   客户端一调就报 `not registered`。

2. **取服务一律 `ctx.get('name')` + 判空，不要写 `ctx.<name>`。** 后者要求该服务已被注入；
   在非标准上下文里会直接抛 `cannot get property "…" without inject`。

3. **每一处注册都必须单独 `try/catch`。** 这是随 DSH 启动加载的常驻插件：任何一处抛出都会让
   **整棵插件树加载失败**，把 GUI 锁进恢复模式 —— 0.1.0 就是这么弄崩的。
   注册失败只允许降级成"按钮报错"，绝不允许冒泡。

## 二、0.1.0 崩溃复盘（别再犯）

0.1.0 写的是 `ctx.connection.handle(CHANNEL, handler)`，启动即抛
`ctx.connection.handle is not a function`，profile 依赖重建随之失败。

真实情况：`connection` 服务**顶层没有 `handle`**，只有 `rpc.handle` / `fetch.register`；
而 `rpc.handle` 内部又依赖 `webServer` 注入，在非标准上下文里会抛
`cannot get property "webServer" without inject`。
**结论：这个插件不该用 connection，用 `webServer.register`。**

比结论更重要的是教训：当时那个方法名是**离线读 DSH 的 bundle** 推断的，从未在活运行时验证，
却把它写进了随启动加载的常驻插件。凡是这类调用，必须先在动态插件里实测存在，再落盘安装。

## 三、模型路由：必须有回退链

`失败：Connection error.` 曾是头号故障。链路是：

1. 插件优先用**会话默认模型**（`agentDefaultModel`）
2. 某份配置里默认路由是 `group-ai/deepseek-v4-pro`
3. 这条路由曾以 **17ms** 失败，错误串就是 `Connection error.`（同一上游的 503/429 也在宿主日志里）
4. 旧实现把「第一条路由的错误」直接抛给了用户

实测（活的 llm 服务）：

| 路由 | 耗时 | 结果 |
|---|---|---|
| `group-ai/deepseek-v4-pro` | 17ms | `Connection error.` |
| `deepseek-official/deepseek-flash` | 609ms 探针 / 6.5s 完整改写 | 正常出词，483 字 |

现在：**首选会话默认 → 失败自动回退 → 全失败才报错**，且失败过的路由进
**5 分钟熔断**，期间直接跳过。状态行显示实际生效的路由与回退次数：

```
6528ms · 模板3 · deepseek-official/deepseek-flash · 回退1
```

**教训**：把「一条可选路由的故障」当成「整个功能的失败」，是设计缺陷，不是环境问题。

## 四、双语检索：为什么要有「意图翻译」

英文库 95% 是英文模板，**中文输入的字对不上任何英文标题**，直接检索命中率极低。链路三步：

1. 非英文草稿先转成 **8–16 个英文检索词**（英文草稿跳过，省一次调用）
2. 用英文检索词匹配英文库（中文原词作补充）
3. 用**用户的语言**输出

### 关键词步骤的三个硬坑

| 配置 | 结果 |
|---|---|
| `maxTokens: 64` + 默认推理档 | ❌ **正文为空**：68 个 chunk 全是 `reasoning-delta`，`finish: max-tokens` |
| `maxTokens: 400` + `reasoningEffort: 'low'` | ⚠️ 不稳定：一次 16 个正文 token，另两次 0 |
| `maxTokens: 1200` + `reasoningEffort: 'low'` | ✅ 稳定出词 |
| `reasoningEffort: 'minimal'` | ❌ `deepseek-flash` 直接报"不支持该推理档" |

**认知一：推理模型的 `maxTokens` 是「推理 + 正文」共享的。** 给小预算不会让输出更短，
而是让正文直接为空。这个坑排查了四轮。**代码里所有调用都显式传 `reasoningEffort: 'low'`。**

**认知二：这批模型全都会推理，没有「不推理的模型」可选。** 实测清单：

```
deepseek-official: deepseek-flash / deepseek-v4-flash / deepseek-v4-pro / deepseek-v4-flash-vision-exp
group-ai:          deepseek-v4-pro
探测 deepseek-chat → 也能用，但也产生 18 个 reasoning chunk
```

**认知三：改提示词形态只在部分模型上有效。** 「让关键词出现在输出最开头」的写法：
对 `deepseek-v4-flash` / `deepseek-v4-pro` 有效，对 `deepseek-flash` 反而全灭。

### 最终选定的组合（各跑 3 次实测产出率）

| 组合 | 产出率 | 平均耗时 |
|---|---|---|
| **deepseek-flash + 现有提示词 + 1200** | **3/3** | 3.0s ← 采用 |
| deepseek-v4-flash + "关键词打头"提示词 + 1200 | 3/3 | 3.1s ← 备用 |
| deepseek-v4-pro + 300 预算 | 2/3 | 7.1s（含一次 15s 超时）← 不用 |

**关键词步骤固定用第一组，不跟随会话默认模型** —— 默认路由可能是坏的，跟随它只会白多一次失败。

### 推理兜底为什么不可靠（但保留）

正文被推理吃光时，推理流末尾看起来像答案，于是从里面提取英文词当检索词。
实测发现**它会捞到模型的内心独白**：

```
✗ "we to convert the user request into english search for prompt template library wants ai which
   translates help me write wechat official account article"
```

**曾经的真实故障**：兜底被放在"第 0 次尝试之后"就 return，结果
① 跳过了本该成功的第 2 次重试；② 把推理独白当成正文喂给下一步生成，
用户看到的就是那段英文乱码。现已改为**本路由两次尝试都失败后**才采用。

## 五、检索结果该当「风格参考」吗？—— 实测结论是不要

三臂对照（同草稿、同模型）：

| 臂 | 需求1 字数/占位/小标题 | 需求2 字数/占位/小标题 |
|---|---|---|
| A 结构指令 + 模板 | 469 / 4 / **8** | 466 / 7 / 5 |
| B 风格指令 + 模板 | **0（空）** | 460 / 4 / **14** |
| C 风格指令 **无模板** | **491** / 4 / 3 | **0（空）** |

两个结论：

1. **最好的产出出现在「无模板」那一臂**（需求1 的 C 臂 491 字）。提升来自**指令**，不是检索结果。
2. **把不相关模板当风格样例是负资产。** 检索结果里出现过
   `分析股票亚康股份的走势`、`电影视觉指导与AIGC分镜生成器` —— 让模型学它们的语域是在教错。

根因是数据：英文库 2,306 条、95% 英文，与中文垂直需求重合度很低。
**检索质量的天花板在语料，不在检索算法。**

## 六、生成的空响应重试

三臂实验里 **6 次生成有 2 次返回空**。所以 `callModel` 对同一路由最多试两次，
第二次把 token 预算抬到 1.75 倍，全败才换路由或报错。

## 七、职责划分：检索为什么在宿主半

中文 → 英文检索词的翻译必须调模型，而模型只在宿主半可用。既然翻译在这里，检索也放这里：

| | 宿主半 | 浏览器半 |
|---|---|---|
| 关键词翻译 | ✅ | — |
| 倒排检索 | ✅ | — |
| 调用模型改写 | ✅ | — |
| 读草稿 / 回写 / 撤销 / 状态行 | — | ✅ |

好处：浏览器半 ~10 KB（原先背着 1.5 MB 索引），逻辑不会两边各一份。

## 八、排障

- 按钮旁的短提示就是第一诊断：`HTTP 500：…` / `索引 HTTP 403` / `fetch 抛错：…`
- **空输入连点三次按钮** = 环境自检，显示页面 origin 与 props 可见性
- 状态行出现 `(salvage)` 后缀 = 该次走了推理兜底（说明正文流被饿死，值得关注）
- 状态行出现 `(retry)` 后缀 = 该次第一次尝试返回空、第二次成功

## 九、配置与可移植性

发布版不能绑死作者机器的路径。当前策略：

| 项 | 解析顺序 |
|---|---|
| `skillsDir` | `config.json` 的 `skillsDir` → 环境变量 `DSH_PROMPT_ENHANCER_SKILLS` → `DSH_HOME/skills` → `~/.dsh/skills` → `''`（禁用本地轨） |
| `extraDataDirs` | `config.json` 的 `extraDataDirs`（默认空） |

实测降级：`skillsDir` 不存在或为空时，`warmup` 返回 `skills: 0`，**不抛错**，
中文轨自动退化为"只用随包语料"，仍能命中随包的 379 条样例 + 24 类骨架。

**注意**：`ctx.config` 在插件上下文里**不可读**（实测抛 `sandbox ctx does not expose "config"`），
所以不要用 schemastery 的 `Config` 方案 —— 加了也读不到。用上面的文件/环境变量方式。

## 十、数据再生成

| 产物 | 生成方式 |
|---|---|
| `lib/match-index.json`、`lib/prompt-library.json` | `prompts.chat` 公开 API 拉全量（97 页 × 24），再建索引 |
| `lib/zh-corpus.json` | 从 `D:\zh-prompt-corpus\all-zh-prompts.jsonl` 筛 general 层 + 抽 templates.md 骨架 |

中文语料的抽取口径（会直接影响检索质量，改前想清楚）：

- **取** `general` 层 379 条 —— 唯一"指令形态"的中文层，剔除电商占位符与量化私有工作流
- **不取** firefly 原始记录 —— 57% 短于 80 字，且"指令形态"那一半是 NLP 基准题（MRC/Cot/NLI），
  不是写提示词的范例；只保留 24 类任务骨架
- **不内嵌** 本地 skill —— 用户会持续编辑，运行时读盘才不会分叉

## 十一、版本号规则

版本号必须能回答"这份包里的语料是哪一版"，否则半年后无法判断某个检索效果是哪套数据产生的。
按改动性质递增：

| 改动 | 递增 | 例子 |
|---|---|---|
| **语料**（重新抽取 / 增删条目 / 换数据源） | **次版本** `0.x.0` | 语料从 379 条扩到 800 条 → `0.3.0` |
| **检索逻辑或模型参数**（分词、权重、路由、预算） | 修订号 `0.2.x` | 改分词器整词规则 → `0.2.1` |
| **界面 / 文档 / 皮肤** | 修订号 `0.2.x` | 新增一套皮肤 → `0.2.1` |
| 不兼容改动（配置项改名、语料格式变更） | 次版本，并在 README 标注 | `lib/zh-corpus.json` 结构变了 → `0.3.0` |

**发布动作**（GitHub 分发，不需要 npm）：

```sh
cd "E:\Boring hong\Documents\代码\dsh\_publish\dsh-zh-prompt-library"
# 1) 改 package.json 的 version  2) 提交  3) 推送
git add -A && git commit -m "chore: bump to 0.x.y"
git push origin main
# 4) 打 tag（用户靠它锁定版本安装）
git tag -a v0.x.y -m "v0.x.y"
git push origin v0.x.y
```

用户安装方式：

```sh
# 跟随最新（不推荐发给别人）
dsh plugin --profile <name> add github:boring-hong/dsh-zh-prompt-library
# 锁定版本（推荐）
dsh plugin --profile <name> add github:boring-hong/dsh-zh-prompt-library#v0.x.y
```

**为什么不用 npm**：本机实测无法注册 npm 账号（`Public registration is not allowed`），
而 `dsh plugin add` 支持从 GitHub 安装并可用 tag 锁版本 —— 于是 GitHub 成为唯一分发渠道。
本机已有先例：`dsh-whale-widget` 就是 `github:MeteorNOX/...` 方式安装的。

### 版本 → 语料对照

| 版本 | 语料 |
|---|---|
| `0.2.0` | 中文：379 条 general + 24 类骨架；英文：prompts.chat 2,306 条 |
