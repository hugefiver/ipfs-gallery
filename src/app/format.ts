import type { ContentRef, GalleryItem, ParsedLocation } from '../shared/contracts'

export function contentAddress(ref: ContentRef): string {
  return `ipfs://${ref.cid}${ref.path.length ? '/' + ref.path.map(encodeURIComponent).join('/') : ''}`
}

export function sourceAddresses(location: ParsedLocation): string[] {
  const source = location.input?.source
  if (!source) return []
  return (source.kind === 'cids' ? source.refs : [source.ref]).map(contentAddress)
}

export function filterItems(items: GalleryItem[], view: ParsedLocation['view']): GalleryItem[] {
  const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase()
  const q = fold(view.q.trim())
  return items.filter(item => {
    if (view.type && item.kind !== view.type) return false
    if (view.tags.length) {
      const tags = new Set(item.tags)
      if (!view.tags.every(tag => tags.has(tag))) return false
    }
    return !q || fold([item.title, item.alt, ...item.tags, ...item.ref.path, item.sourceLabel].join(' ')).includes(q)
  })
}

export function safeFilename(title: string, mime: string): string {
  const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm' }
  const cleaned = [...title].map(char => {
    const code = char.codePointAt(0)!
    return code < 32 || (code >= 127 && code <= 159) ? '_' : char
  }).join('')
  const name = cleaned.replace(/[/\\:*?"<>|\u202a-\u202e\u2066-\u2069]/g, '_').replace(/[. ]+$/g, '').slice(0, 160)
  const base = !name || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) ? '影像' : name
  const ext = extensions[mime] ?? 'bin'
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`
}
