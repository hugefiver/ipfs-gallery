import Button, { type ButtonProps } from '@mui/material/Button'
import type { ReactNode } from 'react'
import type { GalleryError } from '../shared/contracts'
import { contentAddress } from '../app/format'

export function Action({ children, ...props }: ButtonProps) {
  return <Button variant="outlined" {...props}>{children}</Button>
}
export function StatePanel({ title, children, busy = false }: { title: string; children?: ReactNode; busy?: boolean }) {
  return <section className="state-panel" aria-busy={busy}><h3>{title}</h3>{children}</section>
}
export function ErrorDetail({ error }: { error: GalleryError }) {
  const labels: Record<GalleryError['code'], string> = { INVALID_INPUT: '输入格式', INVALID_METADATA: '描述文件', UNSUPPORTED: '不支持预览', NOT_FOUND: '内容未找到', NETWORK: '网络或跨域请求', INTEGRITY: '完整性校验', TIMEOUT: '读取超时', LIMIT: '资源上限', CANCELLED: '已取消', INTERNAL: '内部错误' }
  return <div className="error-detail" role="alert"><strong>{labels[error.code]}</strong><p>{error.message}</p>{error.ref && <p className="cid">{contentAddress(error.ref)}</p>}{error.gateway && <p className="cid">{error.gateway}</p>}</div>
}
