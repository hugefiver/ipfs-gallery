import { useRef, useState, type FormEvent } from 'react'
import { ArrowRightIcon } from '@phosphor-icons/react'
import type { ParsedLocation, Source } from '../shared/contracts'
import { normalizeContentRef, parseLocation, serializeLocation } from '../core/query'
import { GalleryDomainError, toGalleryError } from '../shared/errors'
import { sourceAddresses } from '../app/format'
import { Action } from './Primitives'

export function SourceForm({ location, loading, compact, expanded, inputError, onExpand, onRetry, onSubmit, onInvalid, onCancel }: {
  location: ParsedLocation; loading: boolean; compact: boolean; expanded: boolean; onExpand: (expanded: boolean) => void; onRetry: () => void
  onSubmit: (next: ParsedLocation) => void; onInvalid: (error: unknown) => void; onCancel: () => void; inputError?: string
}) {
  const [mode, setMode] = useState<Source['kind']>(location.input?.source.kind ?? 'unixfs')
  const [draft, setDraft] = useState(() => sourceAddresses(location).join('\n'))
  const [error, setError] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const currentMode = location.input?.source.kind ?? mode
  const showForm = !compact || expanded || !!error
  const duplicatePending = loading && mode === location.input?.source.kind && draft.trim() === sourceAddresses(location).join('\n')
  const visibleError = error || inputError
  function submit(event: FormEvent) {
    event.preventDefault()
    if (composing.current || duplicatePending) return
    try {
      const values = mode === 'cids' ? (draft.includes('\n') ? draft.split(/\r?\n/) : draft.split(',')).map(value => value.trim()) : [draft.trim()]
      if (values.some(value => !value)) throw new GalleryDomainError({ code: 'INVALID_INPUT', message: '请输入有效的 CID 或 IPFS 地址；多个来源之间不能留空项。', retryable: false })
      const refs = values.map(normalizeContentRef)
      const ref = refs[0]!
      const source: Source = mode === 'cids' ? { kind: mode, refs, browse: false } : mode === 'manifest' ? { kind: mode, ref } : { kind: mode, ref, browse: false }
      const next = parseLocation(serializeLocation({ ...location, input: { source }, view: { q: '', tags: [] }, notices: [] }))
      setError('')
      onSubmit(next)
    } catch (value) {
      setError(toGalleryError(value).message)
      onInvalid(value)
      field.current?.focus()
    }
  }
  return <div className="source-control">
    {compact && <div className="compact-source"><div><p className="help">当前来源 · {currentMode === 'manifest' ? '图库描述文件' : currentMode === 'cids' ? '多个 CID' : '目录或文件'}</p><p className="cid">{sourceAddresses(location).join(' · ')}</p></div><div className="actions"><Action aria-expanded={showForm} aria-controls="source-editor" onClick={() => { onExpand(!showForm); if (!showForm) requestAnimationFrame(() => field.current?.focus()) }}>{showForm ? '收起来源表单' : '编辑或更换来源'}</Action>{loading ? <Action onClick={onCancel}>取消读取</Action> : <Action onClick={onRetry}>重新读取来源</Action>}</div></div>}
    {showForm && <form id="source-editor" className="source-form" onSubmit={submit} aria-label="打开影像来源">
    <fieldset className="mode-options"><legend className="sr-only">来源类型</legend>
      {([['unixfs', '目录或文件'], ['cids', '多个 CID'], ['manifest', '图库描述文件']] as const).map(([value, label]) => <label key={value}><input type="radio" name="source-mode" checked={mode === value} onChange={() => { setMode(value); setError('') }} />{label}</label>)}
    </fieldset>
    <label htmlFor="source-input">CID 或 IPFS 地址</label>
    <div className="source-row"><textarea id="source-input" ref={field} rows={mode === 'cids' ? 3 : 1} value={draft}
      aria-invalid={!!visibleError} aria-describedby={`source-help${visibleError ? ' source-error' : ''}`} spellCheck={false}
      onChange={event => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && mode !== 'cids') { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
      <Action type="submit" variant="contained" disabled={duplicatePending} endIcon={<ArrowRightIcon aria-hidden="true" />}>{duplicatePending ? '正在读取' : '打开'}</Action>
      {loading && <Action onClick={onCancel}>取消</Action>}
    </div>
    <p id="source-help" className="help">{mode === 'cids' ? '每行一个 CID 或 IPFS 地址（也可用英文逗号分隔）；路径含逗号时请通过重复 cid 查询参数打开。' : mode === 'manifest' ? '打开经过验证的 JSON、YAML 或 TOML 图库描述文件。' : '粘贴 CID、ipfs:// 地址或 IPFS 网关链接。'} 来源链接的主机不会自动加入网关。</p>
    {visibleError && <p id="source-error" className="error-text" role="alert">{visibleError}</p>}
    </form>}
  </div>
}
