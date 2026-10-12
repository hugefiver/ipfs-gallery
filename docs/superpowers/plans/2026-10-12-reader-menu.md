# Reader 单一菜单入口

## 交付目标与边界

成功显示大图且没有主动打开面板时，Reader 只显示真实媒体和一个始终可见、仅菜单图标的半透明按钮。没有场外标题、计数、上一／下一项、缩放、下载、CID、信息或隐藏按钮。普通图片点击／轻触保持这个状态；所有应用工具通过主动菜单或同一模态内的工具面板可达。

- 保留完整 contained 舞台、双击缩放、多指缩放、放大拖动、未放大时滑动翻页及阅读区左右键。浏览器手势缩放不可禁用。
- Reader 的 Enter／M 打开菜单，Tab 可发现持续存在的菜单按钮。关闭面板或按 Escape 归还菜单入口焦点，不移除入口，不改变模式／URL／历史。没有面板时 Escape 可将焦点送回阅读区，但入口仍在。
- 视频保留原生 controls、playsInline、非自动播放和原生键盘行为；菜单在安全区域左上角，不覆盖底部原生控制，不加整幅视频捕获层。
- 真实加载、读取／解码错误、重试、取消与必要恢复控件仍可见；“仅一个按钮”是成功 Reader 的应用 chrome 约束，不是隐藏错误或视频原生 controls 的理由。无来源继续默认打开来源面板。
- Album 的 chrome 显隐、空隙点击、Enter／M／Tab、Hide／Escape 语义不变；仅从 Album 的下载入口进入 Reader 工具时使用新的明确操作路径。
- 不更改模式分享、item／筛选／来源 URL、隐私、偏好存储、Worker 与资源协议。模式及面板只在内存中。
- 不安装依赖、不执行 Git 写操作；不改 `src/core/`、`src/network/`、`src/worker/`、`src/shared/`、preferences v1、`Primitives`、MUI theme、package 或字体来源／字形／400 与 500 字重／现有字阶。使用已装 React、MUI、Phosphor 与现有样式系统。

本计划交付最终产品行为与实施接口。实现者更新根 `DESIGN.md` 对应 Reader 条款及新令牌为当前约定；不修改其他日期的产品计划，不附决策历史。明确授权范围内直接实施，无额外用户批准关卡。

## 依赖与所有权

相关入口为 `src/app/App.tsx`、`src/app/readerAlbumTypes.ts`、`src/components/{GalleryChrome,GalleryPanels,ReaderSurface,NativeModal}.tsx`、`src/app/app.css`、`src/components/reader.css` 和 `src/theme/tokens.css`。

| 所有者 | 最终职责与接口 |
|---|---|
| `App` | mode、当前 panel、选择与来源、单个 NativeModal、工具 portal host、一次性焦点意图；不接管变换、decode、下载 ticket 或 Blob |
| `useReaderAsset` | 按 service／session／ref 持有当前原图 lease，并向 Reader 与信息面板提供同一 binding；是否打开工具不影响 enabled 或资源生命周期 |
| `ReaderSession` | 当前媒体 decode、缩放／平移、gesture、复制提示及短下载 scope；产生工具 JSX，通过 portal 呈现在 App 模态 host 内 |
| `GalleryChrome` | Reader 的持续 icon-only menu；Album 现有 Menu + Hide 分支。Reader 不依赖 `chromeVisible` 判断入口是否挂载 |
| `GalleryMenu` | 模式、来源、筛选、信息、阅读工具与下载、分享、网络与偏好入口；不直接调用隐藏的 Reader DOM 控件 |
| `NativeModal` | 唯一具名 dialog、showModal、滚动锁、背景 inert、DOM 内全部控件的 Tab／Shift+Tab／Escape 与关闭行为 |

推荐新增内部 `GalleryPanel` 值 `readerTools`，标题“阅读工具”。在现有菜单的下载入口使用清楚的“阅读工具与下载”命名并替换到此面板，不增加第二个 dialog。该内部枚举不进入公开 query 或存储。

Reader props 将 `chromeVisible`／`onToggleChrome` 改为明确的 `onOpenMenu` 和 `toolsHost: HTMLElement | null`；保留 `modalOpen` 作为舞台输入阻断信号。可另传一个仅针对本次打开的初始工具焦点意图；禁止注册全局命令总线、暴露资源对象或用模拟 click 的 imperative 桥接。具体类型名称可按本地惯例调整。

### 工具宿主及事件边界

1. `App` 仅在 `panel === 'readerTools' && mode === 'reader'` 时，在 NativeModal 内容中挂载一个专用 host，通过稳定 callback ref 发布真实元素。关闭、切其他面板、切模式时清除 host。
2. `ReaderSession` 仅向当前连接且有效的 host `createPortal` 工具。工具 DOM 必须属于 dialog 而非 `.app-shell`／`.reader-surface` 的 inert 子树。Reader 和媒体节点不因开关面板而重新挂载。
3. portal 关闭即卸载工具控件，不能仅 opacity 隐藏；保留的来源／网络内容仍由真实 hidden 管理。无焦点落到脱离 DOM 的 host 或隐藏工具。
4. React portal 按 React 树传播事件，现有 NativeModal JSX `onKeyDown` 不能被假定会接到 Reader portal 的按键。最小可靠实现是在实际 dialog 元素上统一监听原生 keydown，替代重复的 JSX 键盘路径；保留原有 IME、防重入、Tab 控件过滤与 Escape 防冒泡语义，注册／卸载随 modal 生命周期管理。也可使用经浏览器验证的等价单一 DOM 范围实现，但不得让 portal 控件绕过焦点陷阱或触发两次关闭。
5. portal 从 Reader 返回的 React 树不要套在具有 stage 快捷键处理器的节点内；App 主区域 Enter 必须保持 target === currentTarget 等范围限制。document 级快捷键尊重 defaultPrevented、panel、IME、修饰键与可编辑／原生视频目标。
6. 初始焦点必须处理 host callback 与 portal 后续提交的时序。打开工具先有可靠的 dialog 内焦点；portal 就绪后，仅本次打开、当前 panel／session／item 匹配且用户未将焦点移到其他控件时，聚焦第一个合适工具。可将工具标题作为暂时／不可用状态的具名焦点目标。不能等原图加载后重新抢焦点。

## 操作路径与数据连续性

### Reader 入口、键盘与手势

- 不依赖 `chromeVisible`、计时器、hover、图片 tap 或视频 focus 揭示菜单。Reader 空态／加载／错误下也保留可用菜单入口，打开模态时入口随背景 inert，不另添可交互入口。
- 图标用现有 Phosphor `ListIcon`；可访问名称“菜单”、`aria-haspopup="dialog"`、恰当的 expanded／controls 关联。视觉只留图标，不用可见“菜单”文字或按钮外围面板伪造第二层 chrome。
- Reader stage／main 的 Enter 与合格的 M 直接 `openPanel('menu')`。Tab 从具名 stage 进入真实菜单按钮，不经过未打开工具；不要保留 Reader 的“Tab 自动揭示整组工具”路径。Album 继续其现有行为。
- 普通 tap 不打开菜单、不切 chrome、不延迟执行显隐。去掉专用于单击揭示的 timer，但保留 gesture cancellation／synthetic-click 消费和双击缩放的正确仲裁。拖动／长按／多点结束不误导航；一次合格 swipe 只选择一项。
- 模态打开时取消现有 gesture，stage 的 pointer／键盘／双击仍阻断。工具内的显式操作按能力判定，不因 `modalOpen` 被全部禁用：图片已解码可缩放；有效已验证资产可下载；首尾导航禁用；复制需要当前有效 item。

### 阅读工具面板

- 展示当前项名称、真实位置计数、上一／下一项、图片缩放／复位／比例、下载与必要反馈。CID、原始地址与信息可保留现有工具操作，也可复用已有信息面板中的复制入口，前提是所有功能路径清楚可达且不重复持有数据。
- 缩放／复位保持工具面板打开以连续调整；关闭后展示结果。视频不显示图片缩放控件。
- 上一／下一项使用当前 filtered 顺序，不循环。激活后关闭工具面板并选择目标项，焦点落在新具名 stage；不是先回旧工具或先回菜单再被迟到资源完成抢走。边界禁用按钮不触发关闭。
- 信息操作用同一个 NativeModal 替换为 `info`；关闭后回持续菜单，不回已卸载的工具按钮。可提供“返回菜单”进行主动面板内导航，不嵌套 modal。
- 下载在面板内显式点击才开始；保留 `service.acquire(item.ref, 0)` 的独立短 ticket、正在准备状态、成功／失败反馈与安全文件名。拿到经过验证的原始字节才生成临时 anchor 并触发真实下载；不把打开面板当作下载成功。
- 菜单→工具→关闭不取消 Reader 主 lease，不重读来源、不重置缩放。下载在同一 ReaderSession 内可跨工具关闭继续，重新打开时呈现当前状态；换 item／session／离开 Reader 按现有 scope cleanup 取消并释放，迟到结果不能下载旧项或更新新项提示。
- 下载保留 1 秒短 lease 以允许浏览器接管 Blob；真实下载完成／取消证据必须来自浏览器与资源计数，不以提示文案为证。
- 解码失败而字节已验证时，错误恢复区仍允许下载已验证字节；未验证／不可用资源不能下载。舞台错误区的动作与模态工具可调用同一内部能力，但分别限制自身允许的输入表面。
- 复制成功／失败及手工复制值保留当前 scope 校验；来源与 item 变化不泄露旧提示，失败不能只报状态而丢失完整值。

### Album 与状态转换

- Album 菜单“阅读工具与下载”将 mode 切为 Reader、保持当前有效 item／来源／筛选／排序，panel 直接为 `readerTools`，启动正常当前原图 lease，不自动下载。明确显示当前媒体及等待验证状态，验证完成后允许下载；不重取来源。
- `changeMode` 的普通模式选择仍关闭菜单。Album 进入／离开及缩略图激活继续维护 bookmark 与 stage 焦点；回 Reader 时立即拥有单菜单入口。不要把 Album 的 `chromeVisible` 改成永远可见。
- 取消、来源替换、popstate、invalid item 与筛选移除当前项，使用现有状态恢复路径。若工具面板失去有效 Reader owner，关闭或切到可解释的现有状态，不留下空 host、可点旧动作或旧焦点意图。
- Reader 关闭任一用户主动工具面板，优先回当前持续菜单；通过键盘 M／stage Enter 打开时也如此，不直接回原来的 stage。模式／来源／导航转换显式请求 stage／来源字段的焦点优先于普通关闭归还。
- 焦点意图携带 session／item（必要时 history revision）并只使用一次；检查目标仍连接、可见、非 inert。迟到 decode、download、copy 结果不得覆盖用户已经移到菜单、其他面板输入或新媒体的焦点。

资源不变量：`AssetService`／`MainAssetSet` 单池、128 MiB、3 slots、当前原图 priority 0、同一验证 Blob、独立短下载 ticket、item／session／mode cleanup 全部保持。不开第二套媒体 hook／pool，不把工具 mount 状态传成 Reader 资源 enabled。

## 视觉令牌与布局

实现前在根 `DESIGN.md` 明确：仅 Reader 持续入口允许半透明背景，其余菜单、表单、信息、状态面板保持不透明；Album chrome 不变。同步更新相关 Reader 说明、键盘、断点、原语和验收段落，不扩大成新品牌或字体改造。

建议新增独立令牌并在 `tokens.css` 使用，颜色从既有纸色派生：

| Token／规则 | 值与用途 |
|---|---|
| `--surface-reader-menu` | `color-mix(in srgb, var(--surface-paper) 82%, transparent)`，默认按钮背景 |
| `--surface-reader-menu-hover` | 同纸色 90%，即时 hover |
| `--surface-reader-menu-pressed` | 同纸色 94%，即时按下 |
| 图标／按钮边界 | `--text-primary`，保持不透明，避免浅边界在亮图上失去辨识 |
| 尺寸／图标 | 按钮 `--control-height` × `--control-height`，48 × 48 CSS px；图标 `--icon-size`，20px；`--radius-control` |
| 焦点 | 在按钮自身有底色的区域内，使用 `--focus-width` 与 `--accent-primary` 的清晰内侧轮廓，内移复用 `--focus-offset`，不依赖未知照片底色 |
| 位置 | `--overlay-top`／`--overlay-left`；与现有 visualViewport／safe-area 偏移协作，不压住 native video 底部 controls |

alpha 只用于背景色，不使用整个 button／父层 opacity；图标、边界、焦点保持完整强度。不加 blur、玻璃滤镜、阴影、渐变或图像遮罩。明／暗／高对比图片下实测图标与焦点至少 3:1；若需微调 alpha／焦点布局，仍沿用现有色系并同步最终 token。

Reader 持续入口不使用每次媒体切换淡入淡出的外壳动画。工具 panel 复用现有 motion 与 reduced-motion 令牌，不增加动画等待或改变操作时序。工具布局在 dialog 中正常流式排列并内部滚动，不沿用场外绝对定位、video 顶部偏移或 Reader 工具的 chrome 高度让位计算；只清理确已无消费者的 Reader 专用规则，Album 的测量／样式不作无关重构。

## 实施波次

### 波次一：单入口与同模态工具完整可用

**结果：** 成功 Reader 默认只保留 icon menu；所有原功能通过该入口、手势或键盘完成。

- 更新 `DESIGN.md`、新增背景 token；在 `GalleryChrome`／`app.css` 将 Reader 样式和 Album 分支明确隔离。
- 更新 App／内部 types／GalleryPanels 的工具路由、host、模式切换和焦点策略；Reader 继续拥有全部媒体与动作状态。
- 将工具渲染移入 portal host，调整动作能力与 stage 输入阻断；处理 NativeModal DOM 键盘边界与 host 就绪焦点。
- 同步 reader CSS 与访问说明。移除 Reader 单击显隐和外工具 focus 查询的专用逻辑，不把 Album 行为一并删掉。

这些文件共享面板／焦点接口，适合单实现所有者或先明确接口后紧密串行修改，不拆成互相猜测的 App 与 Reader 并行任务。

**证明：** 类型／lint、针对性浏览器用例证明默认入口、工具 zoom／download、单 modal、首尾导航与关闭焦点；opening/closing 不重挂媒体、不增来源请求。先运行局部证据，不在未定源码上启动最终审计。

### 波次二：行为覆盖与真实表面验收

**结果：** 回归用例表达新 Reader 行为，Album、资源、恢复和焦点边界仍受保护。

更新而非兼容旧隐藏 chrome 断言；针对已移除行为的专用用例直接替换为有效新功能覆盖，不添加“旧组件不存在”的测试。

| 文件／范围 | 必须体现的真实结果 |
|---|---|
| `tests/e2e/gallery-ui.ts` | Reader 直接发现 menu；`revealChrome` 只用于仍需揭示的 Album 或更名分开；新增 `openReaderTools`；工具 locator 归 dialog 而非 readerSurface；selectAlbumItem 后确认正确媒体与持续入口 |
| `reader.spec.ts` | tap 稳定；M／Enter 打开菜单；double-click／pinch／pan／swipe 与箭头仍正确；菜单工具缩放可用，翻页关闭后新 stage 焦点；加载完成不抢焦点；读失败／解码失败／verified download；关闭工具、换项、换来源的迟到操作与资源释放 |
| `accessibility.spec.ts` | 默认成功图片的应用按钮是具名菜单且可 Tab 到；真实 AX／Tab 可达性；portal 首尾 Tab／Shift+Tab，Escape 只关一层、返回持续菜单；编辑／IME／video 不触发全局命令；short-screen 工具可滚动、可点击 |
| `zoom.spec.ts`、`responsive.spec.ts` | 375／768／1280／1600px、320px／320×240、200% 页面缩放、native pinch visualViewport、横屏与 safe-area；菜单48px，工具至少44px，关闭／下载／恢复动作命中且不被裁切；去掉依赖旧工具 chromeBottom／祖先几何的探测，改量当前 dialog／stage |
| `interactions.spec.ts`、`thumbnails.spec.ts`、`sources.spec.ts` | 新工具路径执行原有真实字节下载；source read 计数、item／filter／sort／share／history、单池重用与取消保持；无来源自动 SourceDialog |
| `album-interactions.spec.ts`、`album-bookmarks.spec.ts` | Album 原显隐和书签不变；Album 下载入口完成 Reader handoff；缩略图回 Reader 的入口断言更新 |
| `preferences.spec.ts`、`lazy-dialogs.spec.ts`、`bootstrap.spec.ts` | 依赖共享 helper 的真实菜单路径，输入／懒载入／存储／初始恢复行为保持；不全局替换 Album 的隐藏断言 |
| `tests/ui/readerInteraction.test.ts` 与现有资源测试 | 保留实际手势分类／取消／pan／资源不变量。只有执行逻辑确实变化才调整；不测试文档或说明文案 |
| `tests/audit/lighthouse.spec.ts` | Reader verifyPage 确认一个持续可见具名菜单、成功媒体及关闭面板；Album／empty 的真实场景保持。只更新产品表面断言和 helper 调用，不改采集设施、阈值或样本 |

真实下载用 Playwright download 事件读取流比对可信 fixture 原始字节，验证文件名；网络记录区分源目录读取与原图读取。打开工具／复制／信息不增媒体请求，Album→Reader 允许其正常原图 consumer，不允许重新读来源。资源测试观察 ticket／Blob 撤销、槽位与迟到结果，不靠成功日志。

浏览器覆盖包括菜单 default／hover／focus／press，工具 disabled／loading／success／failure，明暗底图、native video，普通及 reduced-motion；保留 screenshot／trace／geometry／AX／网络证据路径。对触摸 drag→menu、模态开启取消 gesture、从 portal 边缘 Tab、连按 Escape、切 item 后旧下载完成等高风险路径做实际输入探测，不以纯 DOM 样式推断可用。

### 波次三：生产集成与质量门槛

**结果：** 在同一最终源码生成的隔离生产构建上，功能、部署和审计证据一致。

- 父协调者拥有 `.reader-album-build` 和 4183 的构建／测试调度；不碰 `dist/`、4173 或用户浏览器。实现叶只在自己持有的随机 dev 端口局部 QA，不并发写生产目录、不抢审计 browser。
- 本地终端为 PowerShell。现有脚本可用：`pnpm run typecheck`、`pnpm run lint`、`pnpm test`、`pnpm run doctor:react`。生产准备使用 `pnpm run build:reader-album`；不要运行默认 build 覆盖 dist。每项独立执行并检查结果，不安装工具。
- 局部 E2E 可由父以 `pnpm exec playwright test --config playwright.config.ts reader.spec.ts accessibility.spec.ts zoom.spec.ts responsive.spec.ts --retries=0` 运行；最终 `pnpm exec playwright test --config playwright.config.ts --retries=0` 使用配置默认 2 workers。完整 UI/shared-style 受影响，最终默认套件不能只用局部用例代替。
- 同一 freeze 运行 `pnpm run test:deployment` 的 CSP／子路径验证和 `pnpm run test:smoke` 的真实公共来源验证，保留真实网关波动边界。受影响资源、UI 与部署证据须对应最终构建，不引用旧工具界面的通过结果。
- `pnpm run audit:browser` 继续 empty／reader／album × mobile／desktop 六组，每组三次，四分类中位数均 100 的目标不降；保留 React 观察／质量门槛。使用现有真实 Chrome、run-owned 空 profile／CDP、网关 fixture 与采集设施，不能用 Lighthouse CLI、改分数阈值、削减样本或变更字体获取方式换分。
- 不修改 `tests/audit/audit-route.ts`、owned browser、measured-navigation、React 采集等设施来适配产品行为；仅场景到达／表面 assert 随真实 UX 更新。遇到设施问题由父协调报告与另行界定。
- 生产 CSS／JS、CSP、字体实际请求与现有 dev-only 工具边界仍需检查。任一质量目标未达到，应如实标为未完成并保留失败证据，不把诊断结果当验收。
- 测试完只清理本次创建的 profile、server、CDP、路由与临时文件；不终止或删除并发任务／用户资源。

## 风险与完成判断

主要风险是 portal 的 DOM／React 事件路径不一致、host 二次提交焦点、把 modalOpen 错用于工具能力、旧 session 动作迟到、共享 CSS 改坏 Album 或极短视口，以及审计引用了不同构建。上述接口与验收分别覆盖这些风险。

由父协调者完成计划批评与实现分派；planner 只交付本计划。实现者可选择有证据支持的更小等价结构，但不能改变单入口、原功能可达、所有权、焦点、安全／存储边界或质量门槛。若不可达、真实资源约束冲突、字体／协议／数据保证必须变更，回报阻塞而非自行扩大范围。

完成必须同时具备：成功 Reader 的真实视觉单入口、模态内所有操作可用、错误与视频恢复未弱化、Album 连续性不变、资源／URL／存储不变量以及最终构建的测试与审计证据。计划本身不声称任何实现或浏览器验证已完成。
