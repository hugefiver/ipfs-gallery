import { Component, Suspense, type ComponentType, type LazyExoticComponent } from 'react'
import { Action } from './Primitives'

type LazyDialogProps<Props extends object> = {
  Content: LazyExoticComponent<ComponentType<Props>>
  componentProps: Props
  title: string
}

function LazyDialogFallback({ title, failed }: { title: string; failed: boolean }) {
  return <div aria-busy={!failed}>
    <p role={failed ? 'alert' : 'status'}>{failed ? '界面加载失败。可关闭面板继续浏览，或重新加载页面恢复。' : `正在加载${title}…`}</p>
    {failed && <><p>重新加载会重读当前来源，并丢弃未保存的草稿。</p><Action onClick={() => window.location.reload()}>重新加载页面</Action></>}
  </div>
}

/** Content boundary only; the caller owns the single modal and its close/focus behavior. */
export class LazyDialog<Props extends object> extends Component<LazyDialogProps<Props>, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    const { Content, componentProps, title } = this.props
    const fallback = <LazyDialogFallback title={title} failed={this.state.failed} />
    return this.state.failed ? fallback : <Suspense fallback={fallback}><Content {...componentProps} /></Suspense>
  }
}
