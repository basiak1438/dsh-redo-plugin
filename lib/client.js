/* dsh-redo-plugin client bundle.
 *
 * Adds one "订正" action to every user message row. Clicking it opens a
 * centered editor pre-filled with the original prompt. NOTHING is executed
 * until the user confirms; cancelling at any point leaves the conversation
 * and the workspace exactly as they were.
 *
 * Confirming performs TWO ordered host operations:
 *
 *   1. the rewind (`/redo-plugin @<seq> chat|both`) — shadow-marks the
 *      target message and everything after it and, in mode `both`, restores
 *      the workspace files of that range;
 *   2. the resend (`session.prompt(content, 'queue')`) — appends the edited
 *      text as a REAL user message and starts a new turn.
 *
 * Fully standalone and self-contained: features its own VisibilityBuilder to
 * hide rewound message nodes automatically.
 */
window.__ModuleLoader__.load({
  id: 'dsh-redo-plugin',
  factory: (require) => {
    'use strict'

    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useLayoutEffect = React.useLayoutEffect
    const useRef = React.useRef
    /* React 18 API (the harness ships 18.3): subscribe + getSnapshot store. */
    const useSyncExternalStore = React.useSyncExternalStore

    /* ------------------------------------------------------------------ *
     * Redo Engine Contract
     * ------------------------------------------------------------------ */

    const REDO_RPC_CHANNEL = '/dsh-redo'
    const REDO_COMMANDS = new Set(['redo-plugin', 'redo', 'rewind-plugin', 'rewind'])
    const RPC_TIMEOUT_MS = 8000
    const COMMAND_TIMEOUT_MS = 30000

    /* ------------------------------------------------------------------ *
     * Harness anchors
     * ------------------------------------------------------------------ */

    const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions'
    const CHAT_VIEW = 'chat'
    const USER_SEAT_SELECTOR =
      '[data-chat-flow-kind="user"][data-chat-anchor-key], [data-chat-flow-kind="steering"][data-chat-anchor-key]'
    const IGNORED_PORTAL_SCOPE = [
      '[data-composer-seat]',
      '[data-composer-input]',
      '[data-sidebar-right-panel]',
      '[data-sidebar-chat]',
      '[data-plugin-panel]',
      '[data-correct-overlay]',
    ].join(', ')

    const NS = 'redo'

    /* ------------------------------------------------------------------ *
     * Locales
     * ------------------------------------------------------------------ */

    const DICTS = {
      en: {
        'button.title': 'Redo',
        'button.aria': 'Redo this prompt',
        'overlay.title': 'Redo',
        'overlay.loading': 'Checking what this will revert…',
        'overlay.fileTitle': 'This range also changed {count} file(s)',
        'overlay.fileBody': 'Rewinding restores them to their state before this message.',
        'overlay.fileMore': '…and {count} more',
        'overlay.restore': '↺ {path}',
        'overlay.delete': '✕ {path}  (created in this range)',
        'overlay.continue': 'Continue',
        'overlay.cancel': 'Cancel',
        'overlay.editorHint': 'Enter sends · Shift+Enter for a new line. Confirming rewinds this message and everything after it, then sends your edit.',
        'overlay.backupOff': 'File backup is off — file changes in this range will not be restored.',
        'overlay.images': '{count} image(s) will be resent with the corrected message.',
        'overlay.files': 'File attachments cannot be resent; only text and images will be sent.',
        'overlay.send': 'Rewind and send',
        'overlay.step.rewind': 'Rewinding…',
        'overlay.step.files': 'Restoring files…',
        'overlay.step.send': 'Sending…',
        'overlay.failed.rewind': 'Rewind failed: {message}',
        'overlay.failed.send': 'Rewind finished, but sending failed: {message} — your text is back in the composer.',
        'overlay.failed.stale': 'This message can no longer be rewound. Nothing was changed.',
        'overlay.empty': 'The prompt cannot be empty.',
      },
      zh: {
        'button.title': '订正',
        'button.aria': '订正并重发这条提问',
        'overlay.title': '订正',
        'overlay.loading': '正在检查这一段的改动…',
        'overlay.fileTitle': '这一段还改动了 {count} 个文件',
        'overlay.fileBody': '撤回会把它们还原成这条消息之前的样子。',
        'overlay.fileMore': '…等 {count} 个',
        'overlay.restore': '↺ {path}',
        'overlay.delete': '✕ {path}（本段新建）',
        'overlay.continue': '继续',
        'overlay.cancel': '取消',
        'overlay.editorHint': 'Enter 发送 · Shift+Enter 换行。确认后将撤回这条消息及其之后的全部内容，然后发送你修改后的提问。',
        'overlay.backupOff': '文件备份已关闭 —— 这一段的文件改动不会被还原。',
        'overlay.images': '{count} 张图片将随订正消息一起重发。',
        'overlay.files': '文件类附件无法重发，只会发送文本与图片。',
        'overlay.send': '撤回并发送',
        'overlay.step.rewind': '正在撤回…',
        'overlay.step.files': '正在还原文件…',
        'overlay.step.send': '正在发送…',
        'overlay.failed.rewind': '撤回失败：{message}',
        'overlay.failed.send': '撤回已完成，但发送失败：{message} —— 你改好的文本已放回输入框。',
        'overlay.failed.stale': '这条消息已无法撤回，未做任何改动。',
        'overlay.empty': '提问内容不能为空。',
      },
    }

    /* ------------------------------------------------------------------ *
     * Styles — inherit the harness theme tokens
     * ------------------------------------------------------------------ */

    const CLASS = {
      button: 'dsh-redo-btn',
      backdrop: 'dsh-redo-backdrop',
      panel: 'dsh-redo-panel',
      title: 'dsh-redo-title',
      body: 'dsh-redo-body',
      list: 'dsh-redo-list',
      note: 'dsh-redo-note',
      warn: 'dsh-redo-warn',
      editor: 'dsh-redo-editor',
      actions: 'dsh-redo-actions',
      primary: 'dsh-redo-primary',
      ghost: 'dsh-redo-ghost',
      step: 'dsh-redo-step',
      error: 'dsh-redo-error',
    }

    const ICON_SVG = [
      '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">',
      '  <path d="M9.9 2.6a1.6 1.6 0 0 1 2.3 0l1.2 1.2a1.6 1.6 0 0 1 0 2.3L6.2 13.3l-3.5.9.9-3.5 6.3-8.1Z"',
      '        stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>',
      '  <path d="M8.9 3.6 12.4 7.1" stroke="currentColor" stroke-width="1.25"/>',
      '</svg>',
    ].join('')

    const STYLE = `
.dsh-redo-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px;
  border: none;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsh-redo-btn svg {
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
}
@media (hover: hover) {
  .dsh-redo-btn:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-secondary);
  }
}

.dsh-redo-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.42);
}
.dsh-redo-panel {
  box-sizing: border-box;
  width: min(620px, calc(100vw - 48px));
  max-height: calc(100vh - 96px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #ffffff));
  box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.24));
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.dsh-redo-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
}
.dsh-redo-body { color: var(--dsw-alias-label-secondary); }
.dsh-redo-note {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-redo-list {
  margin: 0;
  padding: 8px 10px;
  max-height: 180px;
  overflow: auto;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}
.dsh-redo-warn {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}
.dsh-redo-editor {
  box-sizing: border-box;
  width: 100%;
  min-height: 132px;
  max-height: 46vh;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  line-height: 21px;
  resize: vertical;
}
.dsh-redo-editor:focus {
  outline: 2px solid var(--dsw-alias-border-l2, #8c959f);
  outline-offset: 1px;
}
.dsh-redo-actions { display: flex; justify-content: flex-end; gap: 8px; }
.dsh-redo-primary,
.dsh-redo-ghost {
  padding: 6px 14px;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.dsh-redo-primary {
  border: none;
  background: var(--dsw-alias-interactive-bg-accent, #1f6feb);
  color: var(--dsw-alias-label-inverse, #ffffff);
}
.dsh-redo-primary:disabled { opacity: 0.5; cursor: default; }
.dsh-redo-ghost {
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  background: transparent;
  color: var(--dsw-alias-label-primary);
}
.dsh-redo-step { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-redo-error {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  word-break: break-word;
}
`

    /* ------------------------------------------------------------------ *
     * Minimal external store (works with useSyncExternalStore)
     * ------------------------------------------------------------------ */

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          if (next === value) return
          value = next
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /* ------------------------------------------------------------------ *
     * Chat snapshot readers
     * ------------------------------------------------------------------ */

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /** Chat nodes, including rows a visibility wrapper marked hidden. */
    function chatNodes(chat) {
      if (chat === undefined || chat === null) return []
      const values = chat.nodes?.values
      if (typeof values === 'function') return [...values.call(chat.nodes)]
      const out = []
      for (const key of chat.order ?? []) {
        const node = chat.nodes.get(key)
        if (node !== undefined) out.push(node)
      }
      return out
    }

    function userNodeAt(chat, seq) {
      for (const node of chatNodes(chat)) {
        if (node.kind !== 'user' && node.kind !== 'steering') continue
        if (node.data !== undefined && node.data.seq === seq) return node.data
      }
      return undefined
    }

    /** Plain text of a user message, block by block. */
    function messageTextOf(node) {
      if (node === undefined || !Array.isArray(node.content)) return ''
      const parts = []
      for (const block of node.content) {
        if (block !== null && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.join('\n')
    }

    /** Image references of a user message; file attachments cannot be resent. */
    function messageAttachmentsOf(node) {
      const images = []
      let hasFile = false
      if (node === undefined || !Array.isArray(node.content)) return { images, hasFile }
      for (const block of node.content) {
        if (block === null) continue
        if (block.type === 'file') {
          hasFile = true
          continue
        }
        if (block.type !== 'image') continue
        const attachment = block.attachment
        if (!isRecord(attachment)) continue
        if (typeof attachment.attachmentId !== 'string' || typeof attachment.mediaType !== 'string') continue
        images.push({ attachmentId: attachment.attachmentId, mediaType: attachment.mediaType })
      }
      return { images, hasFile }
    }

    /* ------------------------------------------------------------------ *
     * Redo command observation
     * ------------------------------------------------------------------ */

    function mentionsSeq(args, seq) {
      if (typeof args !== 'string') return false
      return new RegExp('(?:^|\\s)@' + seq + '(?:\\s|$)').test(args)
    }

    function redoCommandsFor(chat, seq) {
      const found = []
      for (const node of chatNodes(chat)) {
        if (node.kind !== 'command') continue
        const command = node.data
        if (command === undefined || command.name === null) continue
        if (!REDO_COMMANDS.has(command.name)) continue
        if (!mentionsSeq(command.args, seq)) continue
        found.push(command)
      }
      return found
    }

    /** Executed command seqs already on screen, so the new one is distinguishable. */
    function knownRedoSeqs(chat, seq) {
      return new Set(redoCommandsFor(chat, seq).map((command) => command.seq))
    }

    function waitForRedo(chatOf, watchChat, session, seq, known, timeoutMs) {
      return new Promise((resolve) => {
        let settled = false
        let timer
        let unsubscribe = () => {}
        const settle = (value) => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          try {
            unsubscribe()
          } catch {
            /* ignore */
          }
          resolve(value)
        }
        const check = () => {
          let found
          for (const command of redoCommandsFor(chatOf(session), seq)) {
            if (known.has(command.seq)) continue
            if (command.outcome === null || command.outcome === undefined) continue
            if (found === undefined || command.seq >= found.seq) found = command
          }
          if (found !== undefined) settle({ kind: found.outcome.kind, text: found.outcome.text })
        }
        try {
          const off = watchChat(session.sessionId, check)
          if (typeof off === 'function') unsubscribe = off
        } catch {
          /* watching is best-effort; the timeout still settles the promise */
        }
        timer = setTimeout(() => settle(null), timeoutMs)
        check()
      })
    }

    /* ------------------------------------------------------------------ *
     * Prompt content
     * ------------------------------------------------------------------ */

    function bytesToBase64(bytes) {
      let binary = ''
      const chunk = 0x8000
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
      }
      return btoa(binary)
    }

    /** The edited text plus every image, re-read from the durable attachment store. */
    async function buildPromptContent(session, text, images) {
      const parts = [{ type: 'text', text }]
      for (const image of images) {
        try {
          const result = await session.readAttachment(image.attachmentId)
          if (result === undefined || result === null || result.ok !== true) continue
          parts.push({
            type: 'image',
            mediaType: image.mediaType,
            data: bytesToBase64(result.value.data),
          })
        } catch {
          /* a missing image must not block the resend */
        }
      }
      return parts
    }

    /* ------------------------------------------------------------------ *
     * Overlay
     * ------------------------------------------------------------------ */

    function Overlay({ request, deps, onClose }) {
      const { t } = deps
      const [stage, setStage] = useState('loading')
      const [impact, setImpact] = useState({ files: [], backupOff: false })
      const [text, setText] = useState('')
      const [images, setImages] = useState([])
      const [hasFile, setHasFile] = useState(false)
      const [step, setStep] = useState('rewind')
      const [error, setError] = useState('')
      const alive = useRef(true)
      const textarea = useRef(null)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      /* Read-only impact probe, then open the editor (or the file confirm step). */
      useEffect(() => {
        let cancelled = false
        const session = deps.sessionOf(request.sessionId)
        const node = session === undefined ? undefined : userNodeAt(deps.chatOf(session), request.seq)
        if (session === undefined || node === undefined) {
          setError(t('overlay.failed.stale'))
          setStage('error')
          return () => {
            cancelled = true
          }
        }
        setText(messageTextOf(node))
        const attachments = messageAttachmentsOf(node)
        setImages(attachments.images)
        setHasFile(attachments.hasFile)

        void (async () => {
          const outcome = await deps.previewImpact(request.sessionId, request.seq)
          if (cancelled) return
          if (outcome === null || outcome.kind !== 'success') {
            /* The probe is advisory: a failed preview must not block the edit. */
            setImpact({ files: [], backupOff: false })
            setStage('editor')
            return
          }
          setImpact({ files: outcome.files, backupOff: outcome.backupOff })
          setStage(outcome.files.length > 0 ? 'confirm' : 'editor')
        })()
        return () => {
          cancelled = true
        }
      }, [request.sessionId, request.seq])

      /* Land the caret at the end of the editor as soon as it exists. */
      useEffect(() => {
        if (stage !== 'editor') return
        const element = textarea.current
        if (element === null) return
        element.focus()
        const end = element.value.length
        try {
          element.setSelectionRange(end, end)
        } catch {
          /* selection is cosmetic */
        }
      }, [stage])

      /* Escape cancels at every stage that is not already running. */
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || stage === 'running') return
          event.preventDefault()
          onClose()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [stage, onClose])

      const confirm = async () => {
        if (text.trim() === '') {
          setError(t('overlay.empty'))
          return
        }
        const session = deps.sessionOf(request.sessionId)
        if (session === undefined) {
          setError(t('overlay.failed.stale'))
          setStage('error')
          return
        }

        setError('')
        setStage('running')
        setStep('rewind')

        /* Re-probe right before acting: the target may have been compacted
           away, or the session may have moved on while the editor was open. */
        const fresh = await deps.previewImpact(request.sessionId, request.seq)
        if (alive.current === false) return
        if (fresh !== null && fresh !== undefined && fresh.kind === 'error') {
          setError(t('overlay.failed.stale'))
          setStage('error')
          return
        }
        const withFiles = fresh !== null && fresh !== undefined && fresh.kind === 'success' && fresh.files.length > 0
        if (withFiles) setStep('files')

        const known = knownRedoSeqs(deps.chatOf(session), request.seq)
        let commandResult
        try {
          commandResult = await session.command(
            '/redo-plugin @' + request.seq + ' ' + (withFiles ? 'both' : 'chat'),
          )
        } catch (reason) {
          if (alive.current === false) return
          setError(t('overlay.failed.rewind', { message: String(reason) }))
          setStage('error')
          return
        }
        if (commandResult === null || commandResult === undefined || commandResult.ok !== true) {
          if (alive.current === false) return
          setError(t('overlay.failed.rewind', { message: commandResult?.error?.message ?? 'rewind was rejected' }))
          setStage('error')
          return
        }
        if (commandResult.value?.matched !== true) {
          if (alive.current === false) return
          setError(t('overlay.failed.rewind', { message: 'the rewind command is not registered' }))
          setStage('error')
          return
        }

        const outcome = await waitForRedo(
          deps.chatOf,
          deps.watchChat,
          session,
          request.seq,
          known,
          COMMAND_TIMEOUT_MS,
        )
        if (alive.current === false) return
        if (outcome === null || outcome.kind !== 'success') {
          setError(t('overlay.failed.rewind', { message: outcome?.text ?? 'timed out' }))
          setStage('error')
          return
        }

        setStep('send')
        let content
        try {
          content = await buildPromptContent(session, text, images)
        } catch {
          content = [{ type: 'text', text }]
        }
        if (alive.current === false) return

        let sent
        try {
          sent = await session.prompt(content, 'queue')
        } catch (reason) {
          sent = { ok: false, error: { message: String(reason) } }
        }
        if (alive.current === false) return
        if (sent === null || sent === undefined || sent.ok !== true) {
          /* The rewind already happened and cannot be undone, so the least we
             can do is hand the edited text back rather than lose it. */
          try {
            deps.setComposerText(request.sessionId, text)
          } catch {
            /* the composer may be unavailable */
          }
          setError(t('overlay.failed.send', { message: sent?.error?.message ?? 'prompt was rejected' }))
          setStage('error')
          return
        }
        onClose()
      }

      const cancel = () => {
        if (stage === 'running') return
        onClose()
      }

      const files = impact.files
      const shown = files.slice(0, 8)
      const rest = files.length - shown.length
      const children = [h('div', { className: CLASS.title, key: 'title' }, t('overlay.title'))]

      if (stage === 'loading') {
        children.push(h('div', { className: CLASS.body, key: 'loading' }, t('overlay.loading')))
      }

      if (stage === 'confirm') {
        children.push(
          h('div', { className: CLASS.body, key: 'fileTitle' }, t('overlay.fileTitle', { count: files.length })),
          h('div', { className: CLASS.note, key: 'fileBody' }, t('overlay.fileBody')),
          h(
            'div',
            { className: CLASS.list, key: 'fileList' },
            [
              ...shown.map((file) =>
                file.action === 'delete'
                  ? t('overlay.delete', { path: file.path })
                  : t('overlay.restore', { path: file.path }),
              ),
              ...(rest > 0 ? [t('overlay.fileMore', { count: rest })] : []),
            ].join('\n'),
          ),
          h(
            'div',
            { className: CLASS.actions, key: 'actions' },
            h('button', { type: 'button', className: CLASS.ghost, onClick: cancel }, t('overlay.cancel')),
            h(
              'button',
              { type: 'button', className: CLASS.primary, onClick: () => setStage('editor') },
              t('overlay.continue'),
            ),
          ),
        )
      }

      if (stage === 'editor' || stage === 'running') {
        if (impact.backupOff) {
          children.push(h('div', { className: CLASS.warn, key: 'backupOff' }, t('overlay.backupOff')))
        }
        children.push(
          h('textarea', {
            key: 'editor',
            ref: textarea,
            className: CLASS.editor,
            value: text,
            spellCheck: false,
            readOnly: stage === 'running',
            onChange: (event) => setText(event.target.value),
            /* Keys follow the harness composer's own contract: a plain Enter
               sends, Shift+Enter inserts a line break, and every other Enter
               combination (Alt, Ctrl, Cmd, or Shift plus either) is left alone
               so application shortcuts keep receiving it. The composer's
               `busyEnter` preference has no counterpart here — this editor
               submits once, for an idle session, so there is no busy branch.

               A keypress belonging to an IME composition must never submit:
               `isComposing` covers the standard path and `keyCode === 229`
               the browsers that only report the committed key. */
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              if (event.nativeEvent !== undefined && event.nativeEvent.isComposing) return
              if (event.keyCode === 229) return
              if (event.shiftKey) return
              if (event.altKey || event.ctrlKey || event.metaKey) return
              event.preventDefault()
              if (stage === 'editor') void confirm()
            },
          }),
        )
        if (images.length > 0) {
          children.push(
            h('div', { className: CLASS.note, key: 'imagesNote' }, t('overlay.images', { count: images.length })),
          )
        }
        if (hasFile) {
          children.push(h('div', { className: CLASS.note, key: 'fileNote' }, t('overlay.files')))
        }
        if (stage === 'editor') {
          children.push(h('div', { className: CLASS.note, key: 'hint' }, t('overlay.editorHint')))
          if (error !== '') children.push(h('div', { className: CLASS.error, key: 'error' }, error))
          children.push(
            h(
              'div',
              { className: CLASS.actions, key: 'actions' },
              h('button', { type: 'button', className: CLASS.ghost, onClick: cancel }, t('overlay.cancel')),
              h(
                'button',
                { type: 'button', className: CLASS.primary, onClick: () => void confirm() },
                t('overlay.send'),
              ),
            ),
          )
        } else {
          children.push(h('div', { className: CLASS.step, key: 'step' }, t('overlay.step.' + step)))
          children.push(
            h(
              'div',
              { className: CLASS.actions, key: 'actions' },
              h('button', { type: 'button', className: CLASS.primary, disabled: true }, t('overlay.step.' + step)),
            ),
          )
        }
      }

      if (stage === 'error') {
        children.push(h('div', { className: CLASS.error, key: 'error' }, error || t('overlay.failed.stale')))
        children.push(
          h(
            'div',
            { className: CLASS.actions, key: 'actions' },
            h('button', { type: 'button', className: CLASS.ghost, onClick: onClose }, t('overlay.cancel')),
          ),
        )
      }

      return ReactDOM.createPortal(
        h(
          'div',
          {
            'data-correct-overlay': '',
            className: CLASS.backdrop,
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) cancel()
            },
          },
          h(
            'div',
            {
              className: CLASS.panel,
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': t('overlay.title'),
            },
            children,
          ),
        ),
        document.body,
      )
    }

    /* ------------------------------------------------------------------ *
     * Visibility Manager: Automatically hide rewound/redone chat turns
     * ------------------------------------------------------------------ */

    function targetSeqOfArgs(args) {
      if (args === undefined || args === null) return undefined;
      const match = args.match(/@(\d+)/);
      return match !== null ? Number(match[1]) : undefined;
    }

    function isPreviewCommand(command) {
      return (command.args ?? '').includes('preview');
    }

    function isCandidateCommand(command) {
      return (command.args ?? '').includes('__candidates');
    }

    function redoCutsOf(nodes) {
      const cuts = [];
      for (const node of nodes) {
        if (node.kind !== 'command') continue;
        const command = node.data;
        if (command === undefined || command.name === null || !REDO_COMMANDS.has(command.name)) continue;
        if (isPreviewCommand(command) || isCandidateCommand(command)) continue;
        if (command.outcome?.kind !== 'success') continue;
        const marker = command.outcome.sourceEventSeq;
        if (marker === undefined) continue;
        const target = targetSeqOfArgs(command.args);
        if (target === undefined || target > marker) continue;
        cuts.push({ target, marker });
      }
      return cuts;
    }

    function hiddenNode(node) {
      return node.visibility === 'hidden' ? node : { ...node, visibility: 'hidden' };
    }

    function turnOf(node) {
      const turn = node.location?.turn?.turn;
      return typeof turn === 'number' ? turn : undefined;
    }

    class RedoVisibilityBuilder {
      constructor(inner) {
        this.inner = inner;
        this.originals = new Map();
        this.commands = new Map();
        this.byTurn = new Map();
        this.turnProcess = new Map();
        this.derived = new Map();
        this.cuts = [];
        this.cutSignature = '[]';
        this.lastSignature = '[]';
      }
      get empty() {
        return this.inner.empty;
      }
      replace(input) {
        this.setAll(input.nodes);
        this.lastSignature = this.cutSignature;
        return this.inner.replace({
          nodes: this.deriveAll(),
          timeline: input.timeline,
          ...(input.changedTurns !== undefined ? { changedTurns: input.changedTurns } : {})
        });
      }
      apply(input) {
        const affected = new Set();
        let commandsChanged = false;
        for (const node of input.upserts) {
          const previous = this.originals.get(node.key);
          const previousTurn = previous === undefined ? undefined : turnOf(previous);
          const nextTurn = turnOf(node);
          if (previousTurn !== undefined) affected.add(previousTurn);
          if (nextTurn !== undefined) affected.add(nextTurn);
          if (previous?.kind === 'command' || node.kind === 'command') commandsChanged = true;
          this.setOriginal(node);
        }
        if (commandsChanged) this.refreshCuts();
        if (this.cutSignature !== this.lastSignature) {
          this.lastSignature = this.cutSignature;
          return this.inner.replace({
            nodes: this.deriveAll(),
            timeline: input.timeline,
            ...(input.changedTurns !== undefined ? { changedTurns: input.changedTurns } : {})
          });
        }
        const cuts = this.cuts;
        const upserts = new Map();
        for (const node of input.upserts) upserts.set(node.key, this.deriveOne(node, cuts));
        for (const turn of affected) {
          const processKey = this.turnProcess.get(turn);
          const base = processKey === undefined ? undefined : this.originals.get(processKey);
          if (base === undefined) continue;
          const next = this.deriveTurnProcess(base, cuts, turn, this.deriveOne(base, cuts));
          if (this.derived.get(processKey) !== next) upserts.set(processKey, next);
        }
        const list = [...upserts.values()];
        for (const node of list) this.derived.set(node.key, node);
        return this.inner.apply({
          upserts: list,
          timeline: input.timeline,
          ...(input.changedTurns !== undefined ? { changedTurns: input.changedTurns } : {})
        });
      }
      groupInput() {
        return this.inner.groupInput?.();
      }
      publish() {
        this.inner.publish?.();
      }
      setAll(nodes) {
        this.originals.clear();
        this.commands.clear();
        this.byTurn.clear();
        this.turnProcess.clear();
        this.derived.clear();
        for (const node of nodes) this.setOriginal(node);
        this.refreshCuts();
      }
      setOriginal(node) {
        const previous = this.originals.get(node.key);
        if (previous !== undefined) this.unindex(previous);
        this.originals.set(node.key, node);
        if (node.kind === 'command') this.commands.set(node.key, node);
        const turn = turnOf(node);
        if (turn === undefined) return;
        const members = this.byTurn.get(turn) ?? new Map();
        members.set(node.key, node);
        this.byTurn.set(turn, members);
        if (node.kind === 'turn-process') this.turnProcess.set(turn, node.key);
      }
      unindex(node) {
        if (node.kind === 'command') this.commands.delete(node.key);
        const turn = turnOf(node);
        if (turn === undefined) return;
        const members = this.byTurn.get(turn);
        if (members === undefined) return;
        members.delete(node.key);
        if (members.size === 0) this.byTurn.delete(turn);
        if (node.kind === 'turn-process' && this.turnProcess.get(turn) === node.key) {
          this.turnProcess.delete(turn);
          for (const member of members.values()) {
            if (member.kind === 'turn-process') {
              this.turnProcess.set(turn, member.key);
              break;
            }
          }
        }
      }
      refreshCuts() {
        this.cuts = redoCutsOf(this.commands.values());
        this.cutSignature = JSON.stringify(
          this.cuts.map((cut) => cut.target + ':' + cut.marker).sort()
        );
      }
      deriveAll() {
        const cuts = this.cuts;
        const derived = new Map();
        for (const node of this.originals.values()) derived.set(node.key, this.deriveOne(node, cuts));
        for (const [turn, key] of this.turnProcess) {
          const base = this.originals.get(key);
          if (base === undefined) continue;
          const current = derived.get(key) ?? this.deriveOne(base, cuts);
          derived.set(key, this.deriveTurnProcess(base, cuts, turn, current));
        }
        this.derived = derived;
        return [...derived.values()];
      }
      deriveOne(node, cuts) {
        const base = this.originals.get(node.key) ?? node;
        if (base.kind === 'command') {
          const command = base.data;
          if (command?.name !== undefined && command?.name !== null && REDO_COMMANDS.has(command.name)) {
            const args = command.args ?? '';
            const probe = args.includes('preview') || args.includes('__candidates');
            const executed = command.outcome?.kind === 'success' && command.outcome.sourceEventSeq !== undefined;
            if (probe || executed) return hiddenNode(base);
          }
          return base;
        }
        const contained = cuts.some((cut) => cut.target <= base.anchorSeq && base.anchorSeq <= cut.marker);
        return contained ? hiddenNode(base) : base;
      }
      deriveTurnProcess(base, cuts, turn = turnOf(base), current = this.deriveOne(base, cuts)) {
        if (turn === undefined || current.visibility === 'hidden') return current;
        const members = this.byTurn.get(turn);
        if (members === undefined) return current;
        let count = 0;
        let allHidden = true;
        for (const member of members.values()) {
          if (member.key === base.key) continue;
          count += 1;
          if (this.deriveOne(member, cuts).visibility !== 'hidden') {
            allHidden = false;
            break;
          }
        }
        if (count === 0) return current;
        return allHidden ? hiddenNode(base) : current;
      }
    }

    let currentVisibilityCleanup;
    const visibilityPatches = new Map();

    function installChatViewVisibility(ctx) {
      let stopped = false;
      const start = () => {
        const scope = ctx.inject?.(['uiConversation'], (child) => {
          if (!stopped) installOnUiConversation(child.get('uiConversation'), ctx.sessions);
        });
        if (ctx.inject === undefined) {
          installOnUiConversation(ctx.get('uiConversation'), ctx.sessions);
        }
        return () => {
          stopped = true;
          currentVisibilityCleanup?.();
          currentVisibilityCleanup = undefined;
          if (typeof scope === 'function') scope();
        };
      };
      if (ctx.effect === undefined) {
        start();
        return;
      }
      ctx.effect(start, 'dsh-redo chat visibility');
    }

    function installOnUiConversation(ui, sessions) {
      currentVisibilityCleanup?.();
      currentVisibilityCleanup = undefined;
      if (ui?.views === undefined) return;
      const views = ui.views;
      const ensure = () => {
        try {
          const definition = views.entries().find((candidate) => candidate.target === 'chat');
          if (definition === undefined || typeof definition.create !== 'function') return;
          const current = visibilityPatches.get(definition);
          const create = definition.create;
          if (current !== undefined && create === current.wrapper) return;
          const wrapper = function wrappedChatBuilder() {
            return new RedoVisibilityBuilder(create.call(definition));
          };
          definition.create = wrapper;
          visibilityPatches.set(definition, { original: create, wrapper });
          rebuildOpenSessions(ui, sessions);
        } catch {
          /* probe failed gracefully */
        }
      };
      let unsubscribe;
      try {
        unsubscribe = views.subscribe?.(ensure);
      } catch {
        /* view subscribe is best-effort */
      }
      ensure();
      currentVisibilityCleanup = () => {
        unsubscribe?.();
        for (const [definition, record] of visibilityPatches) {
          if (definition.create === record.wrapper) definition.create = record.original;
        }
        visibilityPatches.clear();
        rebuildOpenSessions(ui, sessions);
      };
    }

    function rebuildOpenSessions(ui, sessions) {
      const state = sessions?.list?.getSnapshot();
      if (state === undefined) return;
      const ids = new Set([...(state.ids ?? []), ...Object.keys(state.byId ?? {})]);
      for (const id of ids) {
        const row = state.byId?.[id];
        const retained = row?.retainedBy;
        if (retained === undefined || !Object.values(retained).some((count) => (count ?? 0) > 0)) continue;
        try {
          ui.binding?.(id)?.rebuild?.();
        } catch {
          /* rebuild is best-effort */
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * Per-message action
     * ------------------------------------------------------------------ */

    function CorrectButton({ t, onActivate }) {
      return h('button', {
        type: 'button',
        className: CLASS.button,
        title: t('button.title'),
        'aria-label': t('button.aria'),
        'aria-haspopup': 'dialog',
        onClick: (event) => {
          event.stopPropagation()
          onActivate()
        },
        dangerouslySetInnerHTML: { __html: ICON_SVG },
      })
    }

    /* ------------------------------------------------------------------ *
     * Portal bridge: one action per user message row
     * ------------------------------------------------------------------ */

    function actionsContainerOf(row, ownClass) {
      const buttons = Array.from(row?.querySelectorAll('button') ?? [])
      const structural = buttons.filter((button) => !button.classList.contains(ownClass)).at(-1)?.parentElement
      if (structural instanceof HTMLElement && structural.querySelector('button') !== null) return structural
      return undefined
    }

    function collectTargets(chat, ownClass) {
      const rows = new Map()
      for (const element of document.querySelectorAll(USER_SEAT_SELECTOR)) {
        const key = element.dataset.chatAnchorKey
        if (key !== undefined) rows.set(key, element)
      }
      const targets = []
      for (const key of chat.order ?? []) {
        const node = chat.nodes.get(key)
        if (node === undefined || (node.kind !== 'user' && node.kind !== 'steering')) continue
        /* Withdrawn rows are hidden by the rewind view wrapper: no action there. */
        if (node.visibility === 'hidden') continue
        const user = node.data
        if (user === undefined) continue
        const container = actionsContainerOf(rows.get(key), ownClass)
        if (container === undefined) continue
        targets.push({ key, container, seq: user.seq })
      }
      return targets
    }

    function sameTargets(left, right) {
      return (
        left.length === right.length &&
        left.every((target, index) => {
          const other = right[index]
          return (
            other !== undefined &&
            target.key === other.key &&
            target.container === other.container &&
            target.seq === other.seq
          )
        })
      )
    }

    function CorrectPortals({ sessionId, deps }) {
      const { t } = deps
      const [targets, setTargets] = useState([])
      const [, forceRender] = React.useReducer((count) => count + 1, 0)
      const ready = useSyncExternalStore(deps.rewindReady.subscribe, deps.rewindReady.get)
      const request = useSyncExternalStore(deps.overlay.subscribe, deps.overlay.get)

      useEffect(() => deps.subscribeLocale(forceRender), [deps])

      useLayoutEffect(() => {
        if (!ready) {
          setTargets([])
          return undefined
        }
        let active = true
        let queued = false
        const refresh = () => {
          if (!active) return
          const session = deps.sessionOf(sessionId)
          if (session === undefined) {
            setTargets([])
            return
          }
          const chat = deps.chatOf(session)
          if (chat === undefined) {
            setTargets([])
            return
          }
          const next = collectTargets(chat, CLASS.button)
          setTargets((current) => (sameTargets(current, next) ? current : next))
        }
        const queueRefresh = () => {
          if (queued || !active) return
          queued = true
          queueMicrotask(() => {
            queued = false
            refresh()
          })
        }
        refresh()
        let unsubscribeChat = () => {}
        try {
          const off = deps.watchChat(sessionId, queueRefresh)
          if (typeof off === 'function') unsubscribeChat = off
        } catch {
          /* watching is best-effort */
        }
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            const node = record.target instanceof Element ? record.target : record.target.parentElement
            if (node !== null && node.closest(IGNORED_PORTAL_SCOPE) !== null) continue
            queueRefresh()
            return
          }
        })
        observer.observe(document.body, { childList: true, subtree: true })
        return () => {
          active = false
          observer.disconnect()
          unsubscribeChat()
        }
      }, [sessionId, ready, deps])

      const open = (target) => {
        if (deps.sessionOf(sessionId) === undefined) return
        deps.overlay.set({ sessionId, seq: target.seq })
      }

      const nodes = targets.map((target) =>
        ReactDOM.createPortal(
          h(CorrectButton, { key: target.key, t, onActivate: () => open(target) }),
          target.container,
          target.key,
        ),
      )
      if (request !== null && request.sessionId === sessionId) {
        nodes.push(h(Overlay, { key: '__overlay__', request, deps, onClose: () => deps.overlay.set(null) }))
      }
      return nodes
    }

    /* ------------------------------------------------------------------ *
     * Plugin body
     * ------------------------------------------------------------------ */

    const name = 'dsh-redo'
    const inject = ['slots', 'sessions', 'locale', 'connection']

    function apply(ctx) {
      ctx.effect(function* () {
        yield ctx.locale.register(NS, DICTS)
        const t = ctx.locale.bind(NS)

        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-redo-plugin'
        style.textContent = STYLE
        document.head.appendChild(style)

        const connection = ctx.get('connection')
        const overlay = createStore(null)
        const rewindReady = createStore(true)
        installChatViewVisibility(ctx)

        const sessionOf = (sessionId) => ctx.sessions.binding(sessionId)?.session
        const uiConversation = () => ctx.get('uiConversation')
        const chatOf = (session) => {
          if (session === undefined) return undefined
          try {
            return uiConversation()?.binding(session.sessionId).target(CHAT_VIEW)?.getSnapshot()
          } catch {
            return undefined
          }
        }
        const watchChat = (sessionId, callback) => {
          try {
            const view = uiConversation()?.binding(sessionId).target(CHAT_VIEW)
            return view?.subscribe?.(callback) ?? (() => {})
          } catch {
            return () => {}
          }
        }
        const previewImpact = async (sessionId, seq) => {
          if (connection === undefined) return { kind: 'error', text: 'host RPC is unavailable' }
          try {
            const result = await connection.rpc.call(
              REDO_RPC_CHANNEL,
              'preview',
              { sessionId, seq },
              AbortSignal.timeout(RPC_TIMEOUT_MS),
            )
            if (result === null || result === undefined || result.ok !== true) {
              return { kind: 'error', text: result?.error?.message ?? 'preview failed' }
            }
            const value = result.value
            if (!isRecord(value) || typeof value.backupOff !== 'boolean' || !Array.isArray(value.files)) {
              return { kind: 'error', text: 'invalid preview response' }
            }
            return { kind: 'success', files: value.files, backupOff: value.backupOff }
          } catch (reason) {
            return { kind: 'error', text: String(reason) }
          }
        }
        const setComposerText = (sessionId, text) => {
          try {
            const input = ctx.get('conversation')?.input
            const scope = ctx.sessions.scope?.(sessionId)
            if (input === undefined || scope === undefined) return false
            input.for(scope).setDraft(text)
            input.for(scope).focus?.()
            return true
          } catch {
            return false
          }
        }

        const deps = {
          t,
          sessionOf,
          chatOf,
          watchChat,
          previewImpact,
          setComposerText,
          subscribeLocale: (callback) => ctx.locale.subscribe(callback),
          overlay,
          rewindReady,
        }

        const slots = ctx.slots
        yield slots.inject(HEADER_ACTIONS_SLOT, () =>
          slots.register(
            {
              name: HEADER_ACTIONS_SLOT,
              /* A distinct list-entry id keeps this bridge from shadowing any
                 other header action; the entry portals actions only. */
              id: 'dsh-redo-portals',
              order: 1001,
            },
            function CorrectBridge({ sessionId }) {
              return h(CorrectPortals, { sessionId, deps })
            },
          ),
        )

        yield () => {
          style.remove()
          overlay.set(null)
        }
      }, 'dsh-redo client lifecycle')
    }

    return { name, inject, apply }
  },
})
