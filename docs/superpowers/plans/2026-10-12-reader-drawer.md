# Reader 左侧 Drawer

## 交付目标与边界

阅读器默认只显示媒体与一个真正半透明的 Menu 图标按钮。点击按钮从左侧打开 MUI 风格侧栏；点击侧栏外区域或再次点击同位置、同外观的 Menu 入口关闭。沿用现有功能与设计令牌，不改变媒体、相册、来源或资源协议。

- 使用已安装的 MUI 9.5 与 Phosphor；不安装依赖，不做字体、ButtonBase、Primitives、theme 或 package 性能改造。Source／Network 保留原生输入与现有字号、控件能力；Noto 来源、字形、400／500 字重及字号不变。
- 不修改 core／network／worker／shared、preferences v1、公开 query、CSP、128 MiB／3 slots 预算。模式／面板不写 URL 或存储；来源、history、bookmark、选择及资源取消语义保持。
- 不操作 Git、4173、dist 或用户浏览器。保护工作区已有改动。实现叶负责更新 DESIGN.md 为最终约定；不向旧 reader-menu 计划追加历史。

## 一、统一侧栏与连续状态

主要文件：`src/app/App.tsx`、`src/components/GalleryChrome.tsx`、`GalleryPanels.tsx`、`ReaderSurface.tsx`、`src/app/app.css`、`src/theme/tokens.css`。必要时提取一个小型 Drawer 壳组件，不建立第二套 panel 状态。

1. App 的 `panel: GalleryPanel` 仍是唯一状态源。用一个真正的 MUI `Drawer`（`temporary`、`anchor="left"`、`keepMounted`）承载 menu／source／filters／info／network／readerTools；菜单用 MUI `List`／`ListItemButton`，保持动作、禁用与当前模式语义。沿已安装类型核对 API，不引入新依赖。
2. Paper 为具名 `role="dialog"`、`aria-modal="true"`，保留稳定 `gallery-panel`／标题关联。菜单宽度用现有 menu token，表单宽度用现有 panel token，均受视口约束。侧栏覆盖舞台，不推图、不改变 Album 列宽；正确锁滚动并恢复原 body 样式与滚动位置。loading／error／Network 懒加载共用同一壳，不叠套 dialog。
3. Source／Network 的 visited 内容留在同一稳定子树，inactive 内容 hidden，Drawer 关闭后退出 AX／Tab。关闭／切 panel／Reader↔Album 不丢未提交草稿，不重复 mount／提交／应用；真实来源或 history 变更仍遵守现有 reset key。无来源继续自动显示 Source，错误输入保留并定位。
4. ReaderSession／媒体 owner 与主 lease 不随侧栏开关重挂。`toolsHost` 只在 readerTools 活跃时存在，关闭或切面板立即卸载 host。将 ReaderSurface 的 `closest('dialog[open]')`／`closest('dialog')` 依赖改为真实 Drawer dialog scope 与显式活跃 host 判定；不能把 keepMounted 的隐藏壳判为可用。
5. 保留独立 ReaderDownloadScope：priority 0、已验证原始字节、1 秒短 lease、session／item／mode 变化取消；普通侧栏关闭可继续下载。开关不重取来源、不重置 decode／transform／缩放；迟到复制／下载结果不得污染新项或抢焦点。无消费者的 NativeModal 与其专属测试清理，不添加“组件已删除”的测试。

## 二、唯一入口、焦点与视觉

- Reader 关闭时外部 Menu 可见可访问；打开时原入口隐藏／inert，在 Drawer 焦点范围内呈现同位置同外观的 Menu toggle。始终只有一个可见且可访问的 Menu 按钮；不要求同一 DOM 节点。入口固定于 safe overlay 左上角，48×48、20px 图标，不随侧栏内容滚动或 slide 位移失去可点击位置。任何 panel 打开时再次点击均关闭，而非切回 menu。
- 不关闭 MUI focus trap，不解除整个媒体 inert，不把入口放在遮罩后。Backdrop 消耗实际 pointer／touch 事件，不能穿透触发媒体翻页、缩放、播放或手势。侧栏内部操作不被误判为 outside。
- 入口背景默认约 50% paper，hover／press 仍小于 1；只背景有 alpha，图标／边界／内侧 focus 不透明。内 focus 优先 text-primary，实际合成对比至少 3:1；不用低透明度 accent 规避对比。局部 CSS specificity 覆盖 MUI hover／pressed 规则，禁止 blur／shadow／外字体，其余侧栏面板不透明。
- 开启聚焦当前 panel 的合适控件；DOM 范围键盘处理覆盖来自 ReaderSession 的 portal，IME／229 不关闭，普通 Escape 只消费一次。实测 MUI trap 的 Tab／Shift+Tab 包含工具 DOM；App／MUI／DOM handler 不重复关闭。普通关闭归还可用 Menu，Prev／Next 关闭后聚焦新 stage，模式／来源显式焦点优先；不让 MUI 自动归还覆盖这些意图。工具后提交只有在本次仍打开且用户未移焦时才补焦点。
- Reader 普通 tap 不展开；Enter／M、左右键、双击、swipe／pinch／pan、原生视频控制与浏览器缩放保持。工具缩放留侧栏，首尾导航禁用、不循环；Album chrome／滚动锚点维持。开合使用现有 motion token，只 transform／opacity，快速反转不排队，reduced motion 即时等价。
- 320px、320×240、CSS／浏览器 200% 与原生 pinch 后侧栏 fit、内部滚动、长字段换行；Menu 和末端操作真实可点击，safe-area 不遮挡。

## 三、有效验收证据

更新 `tests/e2e/gallery-ui.ts` 的真实界面选择器及相关断言；保留功能和资源边界覆盖，不锁描述文字、原生 dialog 标签或已删除组件。重点复用 `reader-menu.spec.ts`、`lazy-dialogs.spec.ts`、`interactions.spec.ts`、`responsive.spec.ts`、`zoom.spec.ts`、`preferences.spec.ts` 与 Album 用例。

| 结果 | 必须观察到的证据 |
|---|---|
| 单一入口与覆盖侧栏 | 真实鼠标／触摸点击同位置入口开关；各 panel 的 outside 关闭；AX 仅一个 Menu，关闭的 Drawer 不可 Tab 到；舞台和 Album 列宽开关前后相同。 |
| Portal、焦点、草稿 | 工具首尾 Tab 循环、IME Escape 无动作、Escape 一次关闭、焦点归还与导航新 stage；延迟 Network 成功／失败不抢焦点；Source／Network 编辑后跨面板、关闭重开、模式切换保草稿，未应用值不触发读取。 |
| 资源与交互连续 | 图片 DOM／主资源请求在开关后连续；缩放保持；下载实际字节匹配、取消与旧结果隔离；普通 tap、原生视频、swipe／pinch／pan 与 Album bookmark／history 回归。恶意来源元数据仍只作为文本。 |
| 真实半透明与可用布局 | 375／768／1280／1600 和上述窄屏／缩放边界；亮暗照片与黑白 checker 下 default／hover／focus／press 截图、实际合成像素与对比证据，不能仅检查 CSS alpha。正常／reduced motion、快速连续开关均验证。 |

实现叶先跑相关 unit、typecheck、lint 与自己的随机 dev 端口定向浏览器测试。临时 Playwright 配置必须构造单一配置对象，明确替换 baseURL／webServer／产物路径，不能用 `defineConfig(base, override)` 意外继承 4183。生产懒加载／部署用例由父在生产构建上验证。

父集中执行以下最终门禁；仅复用仍覆盖当前行为的有效证据：

```powershell
pnpm exec vitest run
pnpm run typecheck
pnpm run lint
pnpm run build:reader-album
pnpm exec playwright test --config playwright.config.ts --workers=2 --retries=0
pnpm exec playwright test --config playwright.deployment.config.ts --retries=0
pnpm exec playwright test --config playwright.smoke.config.ts --retries=0
pnpm exec playwright test --config playwright.audit.config.ts --retries=0
```

父独占 `.reader-album-build`／4183，串行协调生产服务与验证；public gateway 验证沿现有 smoke 流程，环境不可用如实报告。审计保持既有 empty／Reader／Album × mobile／desktop 六组各三次、四项中位数严格 100；只调整 surface helper／界面断言，不改变采集器、样本数或门槛，不再做字体／ButtonBase 性能 spike。保留原始报告与实际失败，不把诊断成功或中断当全通过。

浏览器验证只使用本任务拥有的空 context／profile，不登录、不复用用户状态。仅清理本任务资源，结束进程需核对 PID 与启动身份。计划本身不运行测试或浏览器；交付完成需上述真实证据支持，未通过的分数或覆盖项必须明确保留为未完成。
