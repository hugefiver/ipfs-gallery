import type { AssetLease, AssetService, AssetTicket } from '../hooks/assetService'
import type { GalleryItem } from '../shared/contracts'
import { safeFilename } from '../app/format'

export class ReaderDownloadScope {
  active = true
  private ticket?: AssetTicket
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    private service: Pick<AssetService, 'acquire'> | undefined,
    private item: Pick<GalleryItem, 'ref' | 'title'>,
    private notice: (message: string) => void,
    private busy: (pending: boolean) => void,
  ) {}

  async download(verified: AssetLease): Promise<void> {
    if (!this.active || this.ticket || !this.service || !verified.active) return
    this.busy(true)
    this.notice('正在准备已验证的原始媒体…')
    const ticket = this.service.acquire(this.item.ref, 0)
    this.ticket = ticket
    let started = false
    try {
      const original = await ticket.promise
      if (!this.active) return
      if (!original.active) { this.notice('原始媒体已失效，请重试读取后下载。'); return }
      const anchor = document.createElement('a')
      anchor.href = original.url
      anchor.download = safeFilename(this.item.title, original.mime)
      document.body.append(anchor)
      try { anchor.click(); started = true } finally { anchor.remove() }
      this.notice('已开始下载经过验证的原始媒体。')
    } catch {
      if (this.active) this.notice('下载失败；请重试下载，或重试读取原始媒体。')
    } finally {
      const release = () => {
        ticket.cancel()
        if (this.ticket === ticket) { this.ticket = undefined; this.timer = undefined }
        if (this.active) this.busy(false)
      }
      if (started && this.active) this.timer = setTimeout(release, 1000)
      else release()
    }
  }

  dispose(): void {
    this.active = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.ticket?.cancel()
  }
}
