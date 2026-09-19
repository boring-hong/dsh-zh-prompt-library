# dsh-zh-prompt-library

> DSH 输入框里的 **✨增强** 按钮：把你随口一句话的需求，改写成结构化、可直接投喂给大模型的专业提示词。

[English](#english) | 中文

## 它解决什么问题

你写下"帮我分析一下水厂进水COD升高的原因"，直接发给模型往往得到泛泛而谈的回答。
这个插件把你这句话**改写成一条真正的专家级提示词**：

> 你是资深水厂工艺主管……请按"先排除仪表与采样 → 再查管网外来水 → 再查厂内回流与工艺自身"
> 的证据链顺序排查；每条原因给出判断依据、现场核查动作、可量化验证方法；
> 处置按 0-2h 即时止损、2h-72h 中期调整、长期整改三级给出；数据不足处标注"需核实"，不得臆造数值。

那串证据链顺序、三级处置节奏、以及"不得臆造数值"，都不是模型凭空想到的 ——
它们来自插件检索到的**中文专家语料**。

## 与同类插件的差异

npm 上已有做"输入框提示词改写"的插件（如 `dsh-prompt-enhance`），它们多数是**纯 LLM 改写**。

本插件的差异是**双轨检索**：改写前先去中文语料里找出**真正对口**的参考材料，再交给模型。

| | 纯 LLM 改写 | 本插件 |
|---|---|---|
| 中文垂直领域知识 | 靠模型自身 | **从中文语料检索注入** |
| 中文专有词（React / COD / MBR） | 不涉及 | **整词保护，不被切碎** |
| 语料可否自备 | — | 可挂载你自己的专家文档 |

## 双轨检索是什么

改写前检索两类来源，命中就作为参考材料注入：

**中文轨**（主力）

| 来源 | 内容 |
|---|---|
| 随包中文提示词库 | 379 条中文角色提示词样例 |
| 随包任务骨架 | 24 类任务模板（对联 / 翻译 / 程序 / 商品文案…） |
| **你的本地专家语料** | 默认读 `~/.dsh/skills/*.md`，可配置 —— 把你的领域文档放进去，检索命中就整篇注入 |

**英文轨**（补充）：`prompts.chat` 全量模板 2,306 条。中文需求会先转成英文检索词再匹配。

### 中文专有词保护

中文检索最常见的坑是把专有词切碎：`React`、`COD`、`MBR`、`AAOA` 一旦被拆成二字组就再也匹配不上。
分词器规定**字母数字串整体保留**（`react`、`cod`、`gpt-4`、`next.js` 都是单个 token），中文串才产 2-gram。

```
输入: 帮我看看这段 React 代码有没有性能问题，水厂进水COD升高
分词: 帮我 我看 看看 看这 这段 react 代码 码有 有没 有性 性能 能问 问题 水厂 厂进 进水 cod 升高
                    ^^^^^ 整词                                          ^^^ 整词
```

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-zh-prompt-library
```

或手动（本机插件目录 + profile 登记）：

```sh
git clone https://github.com/boring-hong/dsh-zh-prompt-library.git
# 建 junction 到 profile 的 node_modules，并在 profile package.json 的
# dependencies 与 dsh.profile.bundles 里各加一条
```

装完**重启 DSH**：插件随启动加载，输入框右侧会出现 **✨增强** 按钮。

## 使用

| 操作 | 效果 |
|---|---|
| 输入内容后点 **✨增强** | 改写草稿并回写输入框 |
| **再点一次** | 撤销，回到改写前 |
| **右键** | 有检索词时先显示检索词；没有则循环切换皮肤 |
| **空输入连点三次** | 环境自检，显示页面 origin 与 props 可见性 |

状态行显示本次耗时、命中条数与实际使用的模型：

```
3200ms · 模板4 · deepseek-official/deepseek-flash
```

后缀含义：`回退1` = 首选模型失败后自动换了路由；`(retry)` = 第一次返回空、第二次成功；
`(salvage)` = 走了推理兜底（说明那次正文流被饿死，可提 issue）。

### 皮肤

三套配色：**绿（流萤，默认）/ 蓝 / 粉**。**右键按钮循环切换**，选择自动记住。

改默认值：编辑 `lib/client.js` 的 `const SKIN = 'green'`。
加第四套：在同一个文件的 CSS 里复制一个 `.enh-skin-xxx` 块（8 个变量），并加进 `SKINS` 数组 ——
组件逻辑一行都不用动。配色规范见 [`DESIGN.md`](DESIGN.md)。

### 动效与无障碍

"工作中"时按钮会**呼吸**（2.8s 周期，只驱动 opacity 与 box-shadow，不触发布局）。
空闲时完全静止，不在你打字时制造噪声。
`prefers-reduced-motion` 下动效自动关闭，状态信息由文字承担 —— 功能与语义不受影响。

## 配置（可选）

在插件目录放一个 `config.json`：

```json
{
  "skillsDir": "D:/my-domain-docs",
  "extraDataDirs": ["E:/my-corpus"]
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `skillsDir` | `~/.dsh/skills` | **你自己的专家文档目录**（`*.md`，中文 ≥500 字才会被索引）。命中后整篇注入作为参考 |
| `extraDataDirs` | `[]` | 额外的数据目录 |

也可以用环境变量 `DSH_PROMPT_ENHANCER_SKILLS` 覆盖 `skillsDir`。

**`skillsDir` 不存在时不会报错** —— 中文轨自动退化为"只用随包语料"，功能照常。

## 它是怎么做到的（技术摘要）

```
浏览器半 (~10 KB)                     宿主半
  读草稿 ──POST /dsh-prompt-enhancer/enhance──▶ ① 中文轨检索（本地 skill + 中文库 + 骨架）
  回写 ◀─────────────结果 JSON─────────────────  ② 英文轨检索（先翻检索词再匹配）
  撤销/状态行                                      ③ 调用模型改写（带回退链 + 熔断）
```

- 检索与模型调用都在宿主半，浏览器半只有 10 KB，不背索引
- 模型调用有**回退链**（首选失败自动换路由）与 **5 分钟熔断**（不再反复撞死路由）
- 空响应自动重试一次，并抬高 token 预算
- 所有注册单独 `try/catch`：任何一步失败只降级为按钮报错，不会拖垮插件树

细节与踩坑记录见 [`NOTES.md`](NOTES.md)。

## 数据来源与许可

- 英文模板库：[prompts.chat](https://prompts.chat)（公开 API，2,306 条）
- 中文任务骨架：[YeungNLP/firefly-train-1.1M](https://huggingface.co/datasets/YeungNLP/firefly-train-1.1M)
- 中文提示词样例：Haoskyfog/chatgpt-prompts-chinese 清洗筛选

本插件代码以 **MIT** 许可发布，见 [`LICENSE`](LICENSE)。
请同时遵守上述数据来源各自的许可条款。

## 已知限制

- 关键词提取与改写走的是 `deepseek-official` 路由；其他 provider 未做适配
- 中文语料 379 条偏通用，**垂直领域覆盖依赖你自己的 `skillsDir`** —— 这是设计取向，不是缺口
- 英文轨对中文需求帮助有限，主要作为兜底

---

<a id="english"></a>

## English

A DSH composer button that rewrites your one-line request into a structured, production-ready prompt.

It is **not** pure LLM rewriting: before rewriting it retrieves genuinely relevant Chinese reference
material — a bundled Chinese prompt corpus, 24 task skeletons, and (optionally) **your own expert
documents** from `skillsDir`. Chinese proper nouns such as `React`, `COD`, `MBR` are tokenized as
whole units, so they actually match.

Install with `dsh plugin --profile <name> add dsh-zh-prompt-library`, restart DSH, then click
**✨增强** next to the composer. Click again to undo. Right-click cycles three color skins.

Licensed under MIT. See [`NOTES.md`](NOTES.md) for implementation details.
