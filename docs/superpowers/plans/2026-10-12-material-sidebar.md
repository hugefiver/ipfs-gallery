# Material 通高侧栏

## 交付目标与约束

以真实媒体／相册为主体底层，工具是可收起的左侧覆盖层，不把整个界面装进卡片。Reader 关闭侧栏时只保留媒体与半透明 Menu；打开真正的 MUI temporary Drawer，侧栏不推挤媒体，不改变相册列宽。同位置 Menu 再点或点击 outside 均关闭。采用现有 MUI 的 Material 分组、列表、表单与焦点语义，保留项目无阴影、无模糊的平面视觉约定。

- 字体来源、加载方式及 400／500 字重不变；不做字体、ButtonBase、Primitives、theme 或 package 性能重构，不安装或变更依赖。
- core／network／worker／shared、公开 query、preferences v1、CSP、128 MiB／3 slots、数据读取与存储边界不变；不新增模式／面板 URL 或存储字段。来源、metadata、网络说明必须诚实，不编造媒体或健康状态；不可信内容只作文本。
- 保护已有修改及实际 GalleryDrawer、ReaderDownloadScope；不恢复无消费者的 NativeModal。无 Git 操作，不碰 4173、dist 或用户浏览器。旧计划保持原样，DESIGN／README 直接表达最终约定，不记录修改历史或声称验证通过。

## 一、统一侧栏与主体层次

主要文件：`src/app/App.tsx`、`src/components/{GalleryDrawer,GalleryChrome,GalleryPanels,SourceForm}.tsx`；样式限必要的 `src/app/app.css`、`src/components/reader.css`、`src/theme/tokens.css`。同步 `DESIGN.md`／`README.md`；仅当启动／禁用脚本画面也需统一去卡片时修改 `index.html`，不扩展性能工作。

1. 所有 panel 共用通高、贴左、不透明的侧栏 surface：桌面 320 CSS px，窄屏建议 `min(320px, calc(100vw - 24px))`，保留可点击 outside 区域；safe-area 进入内部留白，不制造四周悬浮白块。menu／source／filters／info／network／readerTools 同宽，不使用 800px Body pane、大外边距或圆角白卡。侧栏内部独立滚动，短屏末端操作可达。
2. 统一紧凑 toolbar、同位置 Menu toggle 与语义 h2：Noto Sans、`--type-heading`（20px／500）；正文和标签沿 `--type-body`／`--type-label`。移除 `is-source-entry` 的巨大 display／Serif 标题。Body 按自然流排版，用分组、Divider、列表和 outlined 输入组织内容，不嵌套卡片。
3. 无来源自动打开 Source；主体只留干净基础或必要行内提示，Source 后方没有第二张白色状态卡。真实 loading、error、无匹配、取消与恢复能力仍在正确主状态或侧栏行内呈现，关闭侧栏也不丢必要状态和恢复入口；不能靠隐藏功能换取截图或分数。
4. Source 依实际侧栏容器宽度单列／换行，来源类型、长 CID、说明和操作不溢出。现有 Source 是原生 radio／textarea；可用已安装 MUI 表单组件，但必须保留实际 HTML 输入语义、textarea ref、标签／错误关联、IME、单项 Enter／多项换行、提交去重、取消、重试及网络入口，不改解析协议。

**本波证据：** empty 与真实来源下逐项展示 menu／source／tools／filters／info／network，检查截图、几何与真实点击：通高同宽、主体无重复白卡、无水平溢出，媒体位置和尺寸开合前后不变。

## 二、开合连续性、焦点与资源隔离

- App 的 `panel` 仍是唯一交互状态；Drawer 使用已安装 MUI 的 temporary／keepMounted 与开启的 FocusTrap，具名 dialog。视觉退出态与交互活跃态分离：关闭立即退出 AX／Tab、inert、停止 host 补焦和工具交互；退出完成前保持当前宽度、标题、内容，不切成默认标题、空 Body 或更宽壳。Source／Network 保持稳定子树及草稿；显式 Network 取消仍恢复 committed 值。
- Slide 移动整个不透明侧栏 surface，toolbar 与 Body 不拆成上下错层；同位置 toggle 始终能真实激活，不随 surface 移走、被 backdrop 挡住或落入 inert 范围。允许在同一 MUI 模态焦点范围内独立固定 toggle。打开／关闭态始终只有一个可见、可访问的 Menu。普通关闭焦点回外部 Menu；来源、模式、导航的显式焦点意图优先。
- readerTools 的 active host 在关闭／切 panel 时立即失效，不能为动画延长其寿命；必要的退出视觉仅为 inert 展示，不能保活 portal 交互、异步回调或资源 owner。使用完成回调／本次开合身份隔离，快速重开或换 panel 不被旧 close 回调清空；正常 180ms 仅 transform／opacity，reduced motion 0ms 结果等价。
- Menu 为 safe-area 内 48×48、20px 图标；仅背景 alpha 默认 50%、hover 60%、press 68%，图标／边界／2px 内侧 text-primary 焦点不透明，无 shadow／blur。实际合成像素的控件与焦点对比 ≥3:1，不能只断言 CSS alpha。
- outside 吞掉 pointer／touch，不穿透媒体。portal 的 Escape／Tab／Shift+Tab 受实际 DOM 边界与 MUI trap 约束；IME／229 不关闭，Escape 只处理一次。保留原生视频、普通 tap、双击、swipe／pinch／pan、浏览器缩放与工具导航能力。
- ReaderSession、媒体 DOM、主 lease、decode、zoom 与独立 ReaderDownloadScope 的 owner／refs 不变。已验证原始字节下载沿用 priority 0、1 秒短 lease，普通关闭可继续；source／item／mode／history 变更仍取消旧结果，不抢新焦点或污染新项。Source／Network 跨 panel、关闭重开、模式切换保草稿，真实来源变更继续遵守现有 reset key。

**本波证据：** 正常／reduced motion 的关闭中间帧、快速关闭重开／切 panel、真实同位置 toggle 与 outside 点击、AX／键盘／portal／IME、Source／Network 草稿和显式取消；确认旧回调不清新 panel、工具不残留活跃 host、主媒体与缩放连续、实际下载字节一致且取消隔离有效。

## 三、验收与执行边界

1. **先复现视觉，再验最终结果。** empty 在 320／375／768／1280／2000px 留图；覆盖 2000×1125 + CSS 150%，并单独记录原生 Chrome 150%，不把二者等同、不推断用户实际缩放。保留 320×240、CSS／Chrome 200%、原生 pinch 与 safe-area 边界。实际查看 default／各 panel／退出帧，确认没有大表单浮块、重复白卡、圆角错层或阴影；亮暗媒体及黑白底检查 Menu default／hover／focus／press 像素与对比。
2. **有效回归。** 优先更新 `tests/e2e/reader-drawer.spec.ts` 及 `gallery-ui.ts`，复用 reader-menu、responsive、sources、lazy-dialogs、preferences、zoom、interactions 与 Album 用例；覆盖 Source／模式草稿、Network 取消、原生 pinch 后 backdrop、关闭中间帧、延迟 Network 结果和旧关闭回调。保留 ByteLease、安全、UI、恶意 metadata、query／storage 边界测试。测试行为与接口，不锁文档文字、不添加删除组件的缺席测试。
3. **真实来源闭环。** 填入受控有效来源，经真实验证显示媒体、信息和错误／恢复；下载文件与已验证原始字节一致。验证 Reader／Album 选择与滚动恢复、来源／history 切换、首尾导航及原生视频，不以 mock 成功提示替代资源结果。
4. **轻量本地、集中全局。** 实现叶使用自己拥有的随机 dev 端口做定向检查；临时配置显式替换 baseURL／webServer／产物路径，不继承父 4183。父独占 `.reader-album-build`／4183，最终集中执行 `pnpm run typecheck`、`pnpm run typecheck:shared`、`pnpm run lint`、`pnpm test`、`pnpm run build:reader-album`，再运行 full E2E（`playwright.config.ts`，2 workers／0 retries）、deployment、public smoke 和 audit 各现有配置（0 retries）。不逐小改动重跑全套；不得沿用不覆盖本次视觉／行为的成绩。
5. **完成证据。** 提供截图／trace、实际几何与像素、焦点／交互、请求／lease 和下载字节结果。审计保留 empty／Reader／Album × mobile／desktop 六组各三次、四项中位数严格 100，以真实 Playwright Chromium 运行；不改采集器／样本数／门槛，不继续字体或 ButtonBase 实验。中断、失败、缺失截图／环境覆盖均明确为未完成，不把局部通过当完整验收。

仅使用任务拥有的空 browser context／profile，不登录、不复用用户数据；清理只限任务资源，终止进程核对 PID 与启动身份。计划交付不运行浏览器或测试；父完成 blocker-focused critic 后恢复原实现叶执行，无需重复设计审批。视觉重做与审计目标仍须新证据证明，本文不宣称已通过。
