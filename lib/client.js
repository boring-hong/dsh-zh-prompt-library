/**
 * dsh-prompt-enhancer 浏览器端 bundle（单文件，__ModuleLoader__ 加载）
 *
 * 在输入框右侧工具行注册 ✨增强 按钮。整个检索与改写都在宿主半完成 ——
 * 这里只做三件事：读当前草稿、POST 给宿主、把结果写回输入框（再点一次撤销）。
 * 不背索引、不调模型、不持有任何数据。
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-enhancer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const ENHANCE_URL = '/dsh-prompt-enhancer/enhance'

    // 皮肤：'green' | 'blue' | 'pink'（见 DESIGN.md 第 2 节）。
    // 默认 green —— 与既有流萤主题同调。切换只改这一个常量。
    const SKIN = 'green'
    const SKINS = ['green', 'blue', 'pink']
    const ACTIVE_SKIN = SKINS.includes(SKIN) ? SKIN : 'green'

    function postJson(url, payload, timeoutMs) {
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), timeoutMs)
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload || {}),
        signal: controller.signal,
      })
        .then((res) =>
          res.text().then((text) => {
            window.clearTimeout(timer)
            return { status: res.status, text }
          }),
        )
        .catch((error) => {
          window.clearTimeout(timer)
          return { status: 0, text: 'fetch 抛错：' + String((error && error.message) || error) }
        })
    }

    // 配色与动效规范见同目录 DESIGN.md。
    // 颜色一律走 --enh-* 变量，组件里不出现硬编码色值；加皮肤 = 加一组变量。
    const CSS = `
.enh-btn, .enh-st {
  --enh-accent: #7ee787;
  --enh-accent-strong: #a4f0aa;
  --enh-fill: rgba(126,231,135,.10);
  --enh-fill-hover: rgba(126,231,135,.17);
  --enh-fill-active: rgba(126,231,135,.20);
  --enh-border: rgba(126,231,135,.30);
  --enh-border-hover: rgba(126,231,135,.55);
  --enh-glow: rgba(126,231,135,.35);
}
.enh-skin-blue {
  --enh-accent: #6cb6ff;
  --enh-accent-strong: #9ecbff;
  --enh-fill: rgba(108,182,255,.10);
  --enh-fill-hover: rgba(108,182,255,.17);
  --enh-fill-active: rgba(108,182,255,.20);
  --enh-border: rgba(108,182,255,.30);
  --enh-border-hover: rgba(108,182,255,.55);
  --enh-glow: rgba(108,182,255,.35);
}
.enh-skin-pink {
  --enh-accent: #f778ba;
  --enh-accent-strong: #ff9ecb;
  --enh-fill: rgba(247,120,186,.10);
  --enh-fill-hover: rgba(247,120,186,.17);
  --enh-fill-active: rgba(247,120,186,.20);
  --enh-border: rgba(247,120,186,.30);
  --enh-border-hover: rgba(247,120,186,.55);
  --enh-glow: rgba(247,120,186,.35);
}
.enh-btn { display:inline-flex; align-items:center; gap:5px; height:26px; padding:0 9px;
  border-radius:7px; border:1px solid var(--enh-border); background:var(--enh-fill);
  color:var(--enh-accent); font-size:12px; font-weight:600; font-family:inherit; line-height:1;
  cursor:pointer; white-space:nowrap; user-select:none;
  transition: background .14s ease-out, border-color .14s ease-out, color .14s ease-out, transform .08s ease-out; }
.enh-btn:hover { border-color:var(--enh-border-hover); background:var(--enh-fill-hover); }
.enh-btn:active { transform:scale(.97); }
.enh-btn:focus-visible { outline:2px solid var(--enh-accent-strong); outline-offset:2px; }
.enh-btn[data-busy="1"] { cursor:progress; }
.enh-btn[data-phase="undo"] { border-color:var(--enh-border-hover); background:var(--enh-fill-active); }
/* 呼吸只在「检索/改写进行中」触发 —— 空闲时完全静止，避免在用户打字时持续制造视觉噪声。
   只驱动 opacity 与 box-shadow（合成层属性），不触发布局；不加 will-change。 */
@keyframes enh-breathe {
  0%, 100% { opacity:.58; box-shadow:0 0 0 0 var(--enh-glow); }
  50%      { opacity:1;   box-shadow:0 0 9px 0 var(--enh-glow); }
}
.enh-btn-active { animation: enh-breathe 2.8s cubic-bezier(.45,.05,.55,.95) infinite; }
.enh-st { font-size:11px; white-space:nowrap; font-weight:500; color:var(--dsw-alias-label-tertiary);
  max-width:56vw; overflow:hidden; text-overflow:ellipsis;
  transition: color .2s ease-out; }
.enh-st[data-kind="ok"] { color:var(--enh-accent); }
.enh-st[data-kind="err"] { color:#f85149; }
/* 动效是增强而非信息载体：降级后「在运行」由状态文字承担，功能与语义不变。 */
@media (prefers-reduced-motion: reduce) {
  .enh-btn-active { animation: none !important; opacity:1 !important; }
  .enh-btn, .enh-st { transition: none !important; }
}
`

    function Button(props) {
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const undoRef = React.useRef('')
      const kwRef = React.useRef('')
      const blankRef = React.useRef(0)
      // 皮肤可在界面上直接切：右键按钮循环 green → blue → pink，选择记在 localStorage。
      // 代码里的 SKIN 只是"未设置过偏好时"的初始值。
      const [skin, setSkin] = React.useState(() => {
        try {
          const saved = window.localStorage.getItem('dsh-prompt-enhancer-skin')
          return SKINS.includes(saved) ? saved : ACTIVE_SKIN
        } catch (error) {
          return ACTIVE_SKIN
        }
      })

      const cycleSkin = () => {
        const next = SKINS[(SKINS.indexOf(skin) + 1) % SKINS.length]
        setSkin(next)
        try {
          window.localStorage.setItem('dsh-prompt-enhancer-skin', next)
        } catch (error) {
          /* 无 localStorage 也不影响本次会话内切换 */
        }
        const name = { green: '绿（流萤）', blue: '蓝', pink: '粉' }[next] || next
        setNote({ kind: 'ok', text: '皮肤：' + name + '（再右键继续切换）' })
      }

      let draft = ''
      try {
        if (props.input && typeof props.input.draft === 'string') draft = props.input.draft
      } catch (error) {
        draft = ''
      }
      if (!draft && props.useInput) {
        try {
          const live = props.useInput((state) => state)
          if (live && typeof live.draft === 'string') draft = live.draft
        } catch (error) {
          /* 保留 props.input.draft */
        }
      }

      const setDraft = (text) => {
        if (!props.inputActions || typeof props.inputActions.setDraft !== 'function') return false
        props.inputActions.setDraft(text)
        return true
      }

      const run = () => {
        if (busy) return
        if (undoRef.current) {
          setDraft(undoRef.current)
          undoRef.current = ''
          setNote({ kind: 'ok', text: '已撤销' })
          return
        }
        const text = draft
        if (!text || !text.trim()) {
          blankRef.current += 1
          if (blankRef.current % 3 === 0) {
            setNote({ kind: 'err', text: '自检：' + window.location.origin + ' · inputProps=' + (props.input ? 'yes' : 'no') + ' useInput=' + (props.useInput ? 'yes' : 'no') })
          } else {
            setNote({ kind: 'err', text: '先输入内容' })
          }
          return
        }
        setBusy(true)
        setNote({ kind: 'ok', text: '检索并改写中…' })
        postJson(ENHANCE_URL, { text }, 120000)
          .then(({ status, text: body }) => {
            setBusy(false)
            if (status !== 200) {
              setNote({ kind: 'err', text: 'HTTP ' + status + '：' + String(body).replace(/\s+/g, ' ').slice(0, 90) })
              return
            }
            let parsed = null
            try {
              parsed = JSON.parse(body)
            } catch (error) {
              parsed = null
            }
            if (!parsed) {
              setNote({ kind: 'err', text: '响应不是 JSON：' + String(body).replace(/\s+/g, ' ').slice(0, 80) })
              return
            }
            if (parsed.ok !== true) {
              setNote({ kind: 'err', text: '失败：' + (parsed.error || '未知') })
              return
            }
            if (!setDraft(parsed.enhanced)) {
              setNote({ kind: 'err', text: '无法回写输入框' })
              return
            }
            undoRef.current = text
            kwRef.current = parsed.keywords || ''
            const route = (parsed.usedRoute || '').replace('deepseek-official/', '')
            const skip = parsed.skippedTranslate ? ' · 英文直检' : ''
            const kw = parsed.keywords ? ' · 检索词: ' + parsed.keywords : ''
            setNote({ kind: 'ok', text: parsed.ms + 'ms · 模板' + parsed.usedTemplates + ' · ' + route + skip + kw })
          })
          .catch((error) => {
            setBusy(false)
            setNote({ kind: 'err', text: '失败：' + String((error && error.message) || error) })
          })
      }

      return React.createElement(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        React.createElement('style', null, CSS),
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'enh-btn' + (busy ? ' enh-btn-active' : '') + ' enh-skin-' + skin,
            'data-busy': busy ? '1' : '0',
            'data-phase': undoRef.current ? 'undo' : 'idle',
            title: '双轨检索 + 当前模型改写（成功后重点=撤销，右键切皮肤）',
            onClick: run,
            onContextMenu: (event) => {
              event.preventDefault()
              if (busy) return
              // 有检索词时右键先看检索词，再右键才切皮肤 —— 两种排障/偏好动作不互相顶掉。
              if (kwRef.current) {
                setNote({ kind: 'ok', text: '检索词: ' + kwRef.current })
                kwRef.current = ''
                return
              }
              cycleSkin()
            },
          },
          React.createElement('span', null, busy ? '◌' : '✨'),
          React.createElement('span', null, '增强'),
        ),
        note ? React.createElement('span', { className: 'enh-st enh-skin-' + skin, 'data-kind': note.kind }, note.text) : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('conversation.input.right', () =>
        slots.register({ name: 'conversation.input.right', id: 'enh-btn', order: 50, label: '提示词增强' }, (props) =>
          React.createElement(Button, props),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
