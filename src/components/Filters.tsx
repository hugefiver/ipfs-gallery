import { useMemo, useRef, useState } from 'react'
import { CaretDownIcon, CheckIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import type { GalleryItem, ViewState } from '../shared/contracts'
import { Action } from './Primitives'
const collator = new Intl.Collator('zh-CN')

export function Filters({ items, view, count, partial, disabled, sort, onSort, onChange }: {
  items: GalleryItem[]; view: ViewState; count: number; partial: boolean; disabled: boolean; sort: string; onSort: (sort: string) => void; onChange: (patch: Partial<ViewState>) => void
}) {
  const [draft, setDraft] = useState({ committed: view.q, value: view.q })
  const composing = useRef(false)
  if (draft.committed !== view.q) setDraft({ committed: view.q, value: view.q })
  const search = draft.committed === view.q ? draft.value : view.q
  const setSearch = (value: string) => setDraft({ committed: view.q, value })
  const tags = useMemo(() => [...new Set(items.flatMap(item => item.tags))].sort(collator.compare), [items])
  const selectedTags = useMemo(() => new Set(view.tags), [view.tags])
  return <section className="filters" aria-label="筛选已读取影像">
    <div className="filter-top">
      <label className="search-field">
        <span className="search-field-label">搜索</span>
        <div className="search-input-wrap">
          <MagnifyingGlassIcon className="search-prefix-icon" aria-hidden="true" />
          <input type="search" maxLength={200} value={search} disabled={disabled} onCompositionStart={() => { composing.current = true }} onCompositionEnd={event => { composing.current = false; onChange({ q: event.currentTarget.value }) }} onChange={event => { setSearch(event.target.value); if (!composing.current) onChange({ q: event.target.value }) }} placeholder="按文件名、说明或标签搜索" />
        </div>
      </label>
      <fieldset className="type-options" disabled={disabled}><legend className="sr-only">媒体类型</legend>{([['', '全部'], ['image', '图片'], ['video', '视频']] as const).map(([value, label]) => <label key={value}><input type="radio" name="media-type" checked={(view.type ?? '') === value} onChange={() => onChange({ type: value || undefined })} />{label}</label>)}</fieldset>
      <label className="sort-field">
        <span>排序</span>
        <div className="sort-select-wrap">
          <select value={sort} disabled={disabled} onChange={event => onSort(event.target.value)}>
            <option value="source">来源顺序</option>
            <option value="name">文件名</option>
          </select>
          <CaretDownIcon className="sort-select-arrow" aria-hidden="true" />
        </div>
      </label>
    </div>
    {(tags.length > 0 || view.tags.length > 0) && <div className="tag-options" role="group" aria-label="标签（同时满足所有已选标签，最多 20 个）">{[...new Set([...tags, ...view.tags])].map(tag => <button type="button" className="tag-button" disabled={disabled || (!selectedTags.has(tag) && view.tags.length >= 20)} aria-pressed={selectedTags.has(tag)} key={tag} onClick={() => onChange({ tags: selectedTags.has(tag) ? view.tags.filter(value => value !== tag) : [...view.tags, tag] })}>{selectedTags.has(tag) && <CheckIcon aria-hidden="true" />}{tag}</button>)}</div>}
    {view.tags.length >= 20 && <p className="help">最多同时选择 20 个标签。</p>}
    <div className="filter-summary"><p>{disabled ? '载入来源后可使用筛选' : `${partial ? '已载入' : '共'} ${items.length} 项 · 显示 ${count} 项`}</p>{(view.q || view.type || view.tags.length > 0) && <Action disabled={disabled} onClick={() => { setSearch(''); onChange({ q: '', tags: [], type: undefined }) }}>清除筛选</Action>}</div>
  </section>
}
