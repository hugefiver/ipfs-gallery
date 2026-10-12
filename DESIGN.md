# IPFS Gallery · 影像档案视觉系统

中文优先、纯前端、桌面与移动端。本文是最终视觉与交互约定；不指定框架，不包含组件实现、依赖安装或已通过的浏览器审计。

## 0. Direction · 选定方向

**媒体为主体，工具为可收起的Material侧栏。** 单幅真实图片或视频占据整个动态视口，阅读器只保留半透明菜单图标。左侧工具surface贴边、通高、不透明，各面板同为320 CSS px（窄屏按menu-width收缩），整合紧凑toolbar与独立滚动body；不推挤媒体，不把主体或表单装进圆角白卡。再次点击同位置入口或outside关闭。相册与阅读器共享当前选择；暖纸、橄榄、炭黑只组织真实工具与信息。

## 1. Atmosphere & Identity · 气质与信息顺序

安静、可信、中文优先，没有营销式标题。主视觉只有真实影像与安全区域左上角的菜单图标；没有常驻页头、页脚、来源栏、筛选栏、标题说明或侧栏。阅读器普通点击／轻触无动作，Enter／M 主动打开菜单，Tab 进入真实常驻入口，不依赖 hover、定时器或视频 focus 揭示。

无来源立即打开来源侧栏，主体没有重复来源卡片或假媒体。关闭侧栏后保留真实的行内说明和恢复入口。读取、取消、无匹配、失败及启动／禁用脚本采用主体上的可读信息，而非白色卡片；Source活跃时相关读取／错误信息在侧栏呈现。未知信息不编造，不预设来源或网关健康值。

## 2. Color · 色彩令牌

仅使用本表语义令牌。阅读器与相册使用深色中性底；显现的工具使用不透明暖纸面板，不代表另增完整暗色设置主题。

| Token | Value | 用途 |
|---|---|---|
| `--surface-paper` | `#FAF9F5` | 工具面板、输入底色 |
| `--surface-soft` | `#F5F0E8` | 悬停、轻提示 |
| `--surface-muted` | `#EFE9DE` | 静态骨架、不可用控件 |
| `--text-primary` | `#252523` | 标题、正文、重要元数据 |
| `--text-secondary` | `#55564E` | 帮助、说明、次要标签 |
| `--accent-primary` | `#5C633F` | 打开按钮、链接、选择、焦点 |
| `--accent-pressed` | `#464D30` | 主操作悬停／按下 |
| `--accent-soft` | `#DFE3D2` | 已选筛选底色 |
| `--border-subtle` | `#E6DFD8` | 非交互分隔线 |
| `--border-control` | `#797C6C` | 输入、次级按钮边界 |
| `--status-success` | `var(--accent-primary)` | 已确认可用；同时附文字 |
| `--status-warning` | `#755419` | 超时、部分可用 |
| `--status-error` | `#923D32` | 无效输入、请求或媒体失败 |
| `--surface-viewer` | `#181715` | 阅读器、相册与媒体占位底色 |
| `--text-on-dark` | `var(--surface-paper)` | 深底媒体目标的选择／焦点轮廓 |
| `--text-on-accent` | `var(--surface-paper)` | 主按钮文字 |
| `--surface-overlay` | `var(--surface-paper)` | chrome、菜单、表单与状态面板；完全不透明 |
| `--text-overlay` | `var(--text-primary)` | 覆盖面板文字、图标 |
| `--surface-overlay-backdrop` | `transparent` | 仅阻止背景交互，不装饰或滤暗媒体 |
| `--surface-reader-menu` | `color-mix(in srgb, var(--surface-paper) 50%, transparent)` | 仅阅读器持续菜单按钮背景 |
| `--surface-reader-menu-hover` | `color-mix(in srgb, var(--surface-paper) 60%, transparent)` | 菜单 hover／focus 背景 |
| `--surface-reader-menu-pressed` | `color-mix(in srgb, var(--surface-paper) 68%, transparent)` | 菜单按下背景 |

仅持续菜单按钮允许半透明背景；图标、边界、内侧焦点使用不透明text-primary，focus-width／负focus-offset，在按钮底色范围内保证至少3:1。其余侧栏菜单、表单、信息、状态面板保持不透明。背景alpha不应用到整个按钮，无blur或阴影；覆盖MUI默认hover背景并以实际像素验证。

橄榄色只表达操作、选择与成功，不染大面积背景。错误与警告色只用于对应状态；不能仅以颜色表达信息。文本链接有下划线，已选筛选同时有勾选标记与语义状态。

静态 sRGB 对比：正文／纸底 **14.58:1**，次要文字／纸底 **7.05:1**，次要文字／muted **6.15:1**，主按钮文字 **6.02:1**，已选筛选 **4.85:1**，控件边界／soft **3.77:1**，错误／纸底 **6.79:1**，警告／纸底 **6.56:1**，查看器文字 **17.00:1**。正文追求 AAA；所有文字至少 AA。渲染后的叠加、缩放与字体仍须实测。

## 3. Typography · 中文字阶

- `--font-body`: `"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`。中文正文有清晰笔画与安静节奏，拉丁字符与数字保持同一阅读层。
- `--font-display`: `"Noto Serif SC", "Songti SC", serif`。仅用于页面标题／空状态标题，建立档案的编辑感，不用于表单或密集元数据。
- `--font-cid`: `ui-monospace, "Cascadia Code", Consolas, monospace`。仅 CID／路径使用系统等宽字；不引入第三个下载字体。中文文件名仍用 body。

| Token | Size | Weight | Line height | 用途 |
|---|---|---|---|---|
| `--type-display` | `2.25rem` desktop / `1.75rem` mobile | 500 | 1.35 | 页面／启动标题 |
| `--type-heading` | `1.25rem` | 500 | 1.5 | 侧栏toolbar、状态标题、详情标题 |
| `--type-body` | `1rem` | 400 | 1.75 | 表单、说明、正文 |
| `--type-label` | `0.875rem` | 500 | 1.5 | 按钮、筛选、文件名 |
| `--type-meta` | `0.875rem` | 400 | 1.6 | CID、网关、计数 |

中文不加负字距、不模仿全大写英文标签。说明块最大 `--measure-copy: 34rem`。文件名允许换行，CID 显示首尾缩略但完整值可访问、可复制；详情中的完整 CID／路径用 `overflow-wrap: anywhere`。不将所有文件名变为省略号。

若提供网页字体，使用 WOFF2、`font-display: swap` 与适当子集；动态文件名不能被固定中文子集遗漏。首屏不等待字体，字库失败使用上述中文回退；不得一次加载完整多字重 CJK 字库。

## 4. Spacing & Layout · 组件之前的布局令牌

- Base `--space-1: 4px`；`--space-2: 8px`，`--space-3: 12px`，`--space-4: 16px`，`--space-6: 24px`，`--space-8: 32px`，`--space-12: 48px`，`--space-16: 64px`。所有间距取此表。
- `--content-max: 1600px`（说明内容），`--form-max: 800px`，`--measure-copy: 34rem`；`--breakpoint-tablet: 768px`，`--breakpoint-desktop: 1024px`，`--breakpoint-wide: 1440px`。
- `--radius-flat: 0`（照片），`--radius-control: 4px`，`--radius-panel: 8px`；`--shadow-none: none`。
- `--control-min: 44px`，`--control-height: 48px`，`--icon-size: 20px`，`--border-width: 1px`，`--focus-width: 2px`，`--focus-offset: 4px`。

| Token | Value / 规则 | 用途 |
|---|---|---|
| `--reader-height` / `--reader-height-fallback` | `100dvh` / `100vh` | 阅读舞台固定占满动态视口；后者仅兼容回退 |
| `--reader-min-height` / `--reader-min-width` | `0` / `0` | 短屏不被固定媒体最小高度撑出视口 |
| `--reader-media-fit` / `--reader-media-ratio` | `contain` / `auto`（真实宽／高） | 一幅媒体完整显示，允许中性留边，无裁切 |
| `--reader-media-inset` | `0` | chrome 不占据媒体布局，不缩小舞台 |
| `--safe-top` / `--safe-right` | `env(safe-area-inset-top, 0px)` / `env(safe-area-inset-right, 0px)` | 顶部与右侧安全区域 |
| `--safe-bottom` / `--safe-left` | `env(safe-area-inset-bottom, 0px)` / `env(safe-area-inset-left, 0px)` | 底部与左侧安全区域 |
| `--overlay-inset` | mobile `var(--space-3)`；tablet+ `var(--space-4)` | 工具与屏幕边缘距离 |
| `--overlay-top` / `--overlay-right` / `--overlay-bottom` / `--overlay-left` | 对应 safe token + `var(--overlay-inset)` | 所有控件、关闭按钮与面板的安全边界 |
| `--overlay-padding` / `--overlay-gap` | `var(--space-4)` / `var(--space-3)` | 面板可读留白与动作间距 |
| `--overlay-max-height` | `calc(var(--reader-height) - var(--overlay-top) - var(--overlay-bottom))` | 面板独立纵向滚动，短屏／缩放不丢操作 |
| `--overlay-min-height` | `var(--control-min)` | 状态、工具容器可自然增长，不固定表单高度 |
| `--gallery-chrome-height` | 相册显现入口的实际 CSS 布局高度；未测量时 `var(--control-height)` | 相册 chrome 测量；阅读工具在 dialog 中自然流式排列 |
| `--menu-width` / `--menu-row-min-height` | `min(320px, calc(100vw - var(--overlay-left) - var(--overlay-right)))` / `var(--control-min)` | 所有侧栏同宽、紧凑单列菜单与可触达行 |
| `--menu-gap` | `var(--space-1)` | 紧凑但不缩减触控目标 |
| `--masonry-max-width` / `--masonry-edge` | `none` / `0` | 相册不套居中窄容器，影像边到边 |
| `--masonry-min-height` | `var(--reader-height)` | 短相册也铺满视口，长相册正常滚动 |
| `--album-inset` | viewport <768px `var(--space-2)`；768–1023px `var(--space-4)`；≥1024px `var(--space-6)` | 相册外缘与安全区域，不套窄版心 |
| `--album-column-3-min` / `--album-column-4-min` / `--album-column-5-min` | `640px` / `960px` / `1280px` 实际内容宽度 | 扣除内边距、滚动条后进入三／四／五列；更窄为两列 |
| `--album-gap-small` / `--album-gap-medium` / `--album-gap-large` | `var(--space-2)` / `var(--space-3)` / `var(--space-4)` | 内容宽度 <640／640–959／≥960px 对应间隔 |
| `--album-gap` | 根据实际内容宽度选择上述间隔 | 等宽、最短列放置，不制造卡片 |
| `--album-fallback-ratio` | `4 / 3` | 未知尺寸的稳定占位，不宣称为真实原图比例 |
| `--masonry-media-ratio` | `auto`；就绪后为可信尺寸的宽／高 | 图片及真实视频预览保留实际比例 |
| `--masonry-tile-min-height` | `var(--control-min)` | 极宽影像仍有可用点击目标，影像本身不拉伸 |
| `--masonry-placeholder-min-height` | `calc(var(--space-12) * 2)` | 尺寸未知时中性占位，不能冒充已知比例 |
| `--layer-media` / `--layer-chrome` / `--layer-status` | `0` / `10` / `20` | 媒体、显现工具、必要状态 |
| `--layer-overlay-backdrop` / `--layer-overlay-panel` | `30` / `40` | 模态交互遮罩与不透明面板；一次只开一个面板 |

| Viewport | 阅读器／覆盖层 | 相册与理由 |
|---|---|---|
| Mobile `<768px`（375px） | 单幅 100dvh；持续48×48菜单、20px图标；工具面板可滚动，至少44px目标 | 2 列，space-2 缝隙，保留手机相册密度与真实比例 |
| Tablet `768–1023px`（768px） | 同样仅持续菜单；面板不推开影像 | 按实际内容宽度进入 3／4 列，768px 验收为 3 列 |
| Desktop `≥1024px`（1280／1600px） | 单幅阅读而非双幅；工具面板有宽度上限 | 1280px 验收为 4 列、1600px 为 5 列；按内容宽度而非设备名称计算 |

阅读器固定视口、媒体完整 contained；相册为独立滚动面，safe-area 仅保护外缘内容与操作，不引入普通页边。覆盖层固定定位，开合不改变阅读器尺寸或相册列宽。所有容器 `min-width: 0`；长路径换行，无水平溢出。阅读器没有强制浏览器 Fullscreen API 的要求。

## 5. Components · 规划原语与页面状态

### Planned Showcase Primitives

以下是视觉原语与状态要求，不是组件接口文档。全部使用前述令牌；具体接口由独立产品计划定义。

| 原语 | 结构与令牌 | 必查状态 |
|---|---|---|
| Button / icon button | control-height、space-3/4、radius-control；主按钮 accent，其余 paper；Phosphor SVG、统一 icon-size，图标按钮有中文名称 | default、hover、focus、press、disabled、loading、success/error 反馈 |
| Source field | 可见标签“CID 或 IPFS 地址”；body，space-3/4；control 边界；提示与错误置于下方 space-2 | empty、filled、focus、invalid、request loading、timeout、success |
| Filter / sort | “全部／图片／视频”单选组；标题／alt／标签／路径本地搜索、标签筛选；“来源顺序／文件名”原生 select | default、selected、hover、focus、无匹配；来源未就绪时禁用并说明 |
| Gateway status / selector | 中文状态 + 网关主机名；可展开最近请求结果、检查时间与切换；meta 字阶 | 未检查、检查中、当前可用、较慢、不可用、未知、切换中 |
| Reader / persistent menu | reader-height、viewer 深底；单幅 contain；control-height方形、ListIcon/icon-size、reader-menu背景、radius-control | default、hover、focus、press、loading、verified、failed/retry、视频 |
| Reader tools | 同一左侧MUI temporary Drawer，surface-overlay，流式工具、至少control-min；真实文件名、位置、导航、缩放、下载／复制／信息 | open/close、portal Tab／Shift+Tab／Escape、首尾disabled、缩放、下载pending/success/error |
| Album masonry / tile | album-column 阈值／gap 与 masonry-media-ratio；平直真实影像，不加常驻标题、卡片底或装饰元数据 | loading、真实比例、尺寸未知、active、hover/focus、失败、无匹配、滚动恢复 |
| Menu / mode actions | menu-width/gap/row-min-height；单列中文动作，当前模式有文字／勾选状态 | open/close、focus/return、Escape、selected、disabled |
| Source / search / info / network / preferences sidebar | menu-width、不透明平直通高surface；toolbar的Noto Sans/type-heading/500标题；body的分组、Divider、outlined原生输入；无嵌套Card | open/close、focus trap/return、long content、短屏、safe-area、invalid、IO failure |
| Main state / skeleton | 主体上的标题、真实说明与恢复动作，无白色卡片；真实尺寸优先，中性静态占位 | 初始无来源、来源空、无匹配、载入、取消、部分失败、整体失败 |
| Download / share / copy | 明确对象、即时反馈、失败后保留可复制值；不自动启动外部分享 | pending、success/error、未验证不可下载、无来源不可分享 |

### Opening & source flow

- 初始无来源自动打开来源覆盖面板；有内容后只能从菜单主动编辑来源，不常驻表单。输入／URL 错误打开对应面板并定位关联字段；保留输入。提示：“粘贴 CID、ipfs:// 地址或 IPFS 网关链接。”搜索与筛选仅作用于已读取列表，不承诺全网检索。
- “打开”与 Enter 提交；中文输入法组合期间 Enter 不提交。空值／无效来源使用关联错误：“请输入有效的 CID 或 IPFS 地址。”保留输入并聚焦字段。CID、可接受 URI 与网关路径须真实验证，不能仅看字符串前缀。
- 请求开始立即显示“正在读取来源…”与取消动作；不显示虚构百分比。防止同一请求重复提交；可取消、修正、重试。旧请求不能覆盖新来源，网关切换保留 CID 与路径。
- 来源变更立即取消旧请求、撤销旧媒体并清空旧图库，明确显示新来源的读取或错误状态；旧响应不能被当成新结果。
- 没有来源：“打开一个影像来源”／“粘贴 CID 或 IPFS 地址，开始浏览。”来源无媒体：“这个来源中没有可预览的影像。”无匹配：“没有符合筛选的影像。”提供清除筛选。
- 来源失败：“暂时无法读取这个来源。”提供重试、切换网关、编辑地址。单个媒体失败只影响该项，保留文件名、重试／原始地址；部分失败用摘要说明，不阻塞其余影像。
- 不猜测拍摄时间或文件大小。计数分别表述实际已解析项与失败项；尚未完成的列表使用“已读取 N 项”，不伪装成总数。仅在枚举确实完整时显示总数。

### Network truth & content boundaries

网关状态来自实际浏览器请求，只代表该网关／本次来源，不代表“IPFS 全网在线”。离线、CORS 拒绝、超时与内容缺失不能混成同一种错误；无法判断原因时显示“无法确认”，技术详情可展开。设置面板披露启用网关及其可见 CID、IP 的隐私边界；检索在这些网关间自动回退与负载均衡，不逐次要求确认，绝不添加未配置的服务。粘贴网关链接仅提取 IPFS 引用，不自动采用链接主机。

真实 IPFS 内容不可信：所有元数据只作为文本展示，不执行 HTML／脚本，不注入 SVG 页面标记。仅使用验证后的允许协议与地址；图片／视频之外显示“不支持预览”与安全原始地址，不冒充图片。视频不自动播放，原生控制始终可用，不为了 chrome 隐藏而禁用或覆盖它们。

### Reader, menu & album · 模式与连续性

- 默认进入阅读器；来源就绪后只显示媒体和持续菜单图标，URL `item` 仅选择媒体，不开启模态。标题、位置、上一／下一项、缩放、下载、CID、地址与信息全部在主动打开的面板中。首尾禁用导航，不循环；工具导航关闭面板后聚焦新阅读区，缩放保持面板打开。
- 菜单为简短单列：**阅读／相册、来源、搜索与筛选、信息、阅读工具与下载、分享、网络、偏好**。当前模式明确标记；无当前媒体的工具／信息禁用并说明。选择模式关闭菜单；工具替换菜单，不堆叠模态。相册工具入口保留选择／来源／筛选／排序进入Reader，仅显式点击下载获取已验证原始字节。
- 阅读器普通轻触／点击无动作；双击缩放、多点缩放、放大拖动、未放大滑动与左右键翻页保持。不要覆盖整幅视频的点击捕获层；视频原生controls、playsInline、播放、进度、音量、全屏及键盘操作优先且不自动播放。菜单位于左上角，不干涉底部原生控制，不由视频pointer／focus改变。浏览器手势缩放不可禁用。
- 相册按当前筛选／排序顺序将下一项放到最短列，相同高度从左到右；使用真实宽高，不做方形裁切、不放大 hover、不加滤镜。DOM 与键盘保持项目顺序，不能按列重新排列可访问顺序。尺寸未知只显示诚实中性占位；就绪后使用真实比例，重排保护可见锚点。
- 点按／键盘激活缩略图回到该项阅读器与持续菜单；键盘返回聚焦具名阅读区。再次打开相册恢复原滚动位置与选中项；关闭信息、换模式、显隐相册chrome不重取来源，不重置当前项。断点／尺寸变化时以稳定项目锚点恢复位置；筛选移除锚点则使用就近有效项。
- 相册没有常驻顶栏、卡片标题或元数据；点按相册空隙或在具名相册区按 Enter／M 揭示工具，缩略图激活仍直接阅读。选中／聚焦状态用轮廓与可访问语义，不仅靠颜色。可信视频类型标记可在揭示状态中显示，不把视频当成静态照片。

### Overlay & keyboard · 覆盖与焦点

阅读器与相册是具名可聚焦主区域。阅读器Enter／M打开菜单，Tab进入持续菜单；相册保留Enter／M／Tab揭示chrome语义。未打开工具退出Tab顺序与可访问树。输入框、文本选择、IME及原生视频控制中的按键不触发主区域快捷键。

Escape一次只关闭当前面板，Reader普通关闭回当前持续菜单；模式／来源／导航的显式焦点意图优先。没有面板时Reader Escape回阅读区但不隐藏菜单；Album隐藏chrome并回主区域。不得改变模式或history.back()。左右键仅在阅读区且未编辑／未操作视频时导航，迟到资源完成不抢焦点。

所有工具共用一个具名MUI temporary Drawer，背景inert、MUI trap和实际DOM键盘边界覆盖portal。320px通高surface将toolbar与body一同滑动，Menu在同一焦点范围内独立固定；外部入口只在关闭时呈现。outside消耗事件，不穿透媒体。交互panel是唯一活跃状态；退出paint保留同宽、标题与内容，立即退出AX／Tab／交互。工具host立即失效，退出工具只显示inert DOM静态paint，没有事件、异步回调或资源owner；没有旧exit回调清空重开的面板。keepMounted保留Source／Network草稿，真实来源/history遵守原reset key。补焦只在本次活跃且用户未移焦时执行。侧栏开关不重挂媒体、不取消主lease、不重取来源、不重置缩放；短下载lease可跨关闭继续，item／session／mode变化取消。短屏、CSS／浏览器缩放及native-pinch下控件可达。
Source与网关输入按真实侧栏容器单列／换行。逻辑宽度不超过224px（sidebar-width尺度）时，toolbar的48px入口／关闭按钮保持首行，20px标题占第二行；短视口的body仍有独立滚动空间。
侧栏surface外坐标只保留native visualViewport偏移，不以safe-area形成外侧空隙。safe-top／left／right进入toolbar内padding，safe-left／right／bottom进入body内padding及底部scroll-padding；固定Menu仍使用原overlay安全坐标。

### Browser preferences · 浏览器设置

“保存设置到此浏览器”默认关闭；只使用现有 `ipfs-gallery.preferences.v1` 及其布局、桌面／手机侧栏、已应用本地网关白名单，不更名、不新增模式或 overlay 字段。已有布局／侧栏值不自动打开 chrome、侧栏或覆盖层；不得将其重新解释为阅读／相册模式。模式、chrome／面板显隐、相册滚动位置仅为当前会话内存状态，不产生隐式存储更新。

不保存 CID、路径、item、筛选、媒体、来源历史、认证信息或统计。关闭保存只删除本 key 并保留内存偏好；清除并恢复默认只操作本 key。访问／写／删除失败如实提示，内存仍可用，不跨标签同步。有效网关优先级保持 URL 显式网关 > 本地网关 > 默认；仅明确“应用并重新读取”把编辑网关设为本地偏好，打开分享、切模式、显隐工具或开启保存均不自动保存 URL 网关。清除偏好不覆盖当前显式 URL 网关。

现有来源／选择／筛选 URL 协议保持不变；不新增 `mode`、chrome、overlay 等公开参数。分享不包含这些瞬时状态。来源与选择可能进入浏览器自身历史，URL 不是秘密；它们不会写入应用偏好。根页面无来源时不自动请求演示 CID，不使用假 IPFS 图片填充。

网关会看到访问者 IP、请求 CID 和时间；请求不带 cookie／credentials，不发 referrer，拒绝重定向。只在已配置 HTTPS 公网网关之间自动回退／负载均衡，不添加服务；粘贴链接不采用原主机。统计不外发，不持久化媒体或 CID 历史。配置拒绝凭据、查询、fragment、localhost、字面私网／link-local IP；浏览器无法保证公网域名 DNS 不映射到私网，此残余风险须如实披露。

## 6. Motion & Interaction · 反馈而非装饰

`--motion-micro: 120ms`，`--motion-panel: 180ms`，`--motion-reduced: 0ms`，`--ease-feedback: cubic-bezier(0.2, 0, 0, 1)`。只对 opacity／transform 做动画；状态色即时变化，无布局动画。

- hover：主按钮用 pressed，次级控件用 soft；照片不放大、不移动；键盘 focus 同样明确。
- focus-visible：纸面使用 accent 的 focus-width 外描边与 focus-offset，深底媒体目标使用 on-dark。焦点立即出现，不被 overflow／视口边缘裁切；禁用控件可读并解释原因。不使用默认浏览器焦点圈，也不以低透明度隐藏文字。
- press：按钮即时颜色反馈；动作不等待动画。完成复制用“已复制 CID”文字与 polite 状态播报；失败保留完整值供手动复制。
- open/close：侧栏不透明内容使用panel时长从左侧transform滑入／退出，入口保持原位置不淡入淡出；相册chrome保留opacity。重复输入可中断，不排队，隐藏语义与焦点立即更新。模式切换不做飞图／缩放装饰；筛选立即更新，不对整批影像做入场瀑布动画。
- loading：静态骨架与“正在读取…”文本、容器 `aria-busy`；不闪烁、不无限脉冲。确定进度才使用 progress，计数播报合并而非逐张打断。
- reduced motion：开合直接完成，信息、焦点与操作完全等价。无需滚动揭示、视差、纹理或环境动画。

## 7. Depth & Surface · 平面边界

**策略：borders-only，shadow-none。** 结构分隔使用border-width／border-subtle，交互边界使用border-control；Reader持续菜单使用不透明text-primary边界与图标及独立alpha背景。工具面板仍是不透明实色，禁止玻璃、阴影、渐变、纹理、滤镜与装饰遮罩。照片平直边缘，相册只用间隙组织。文字必须使用不透明面板保证对比。

## 8. Accessibility & Verification · 约束与验收

目标 **WCAG 2.2 AA**，主要正文达到 AAA 对比。`lang="zh-CN"`、清楚的页面标题、语义 landmark、可访问的阅读区／相册入口。所有点击目标至少 control-min，200% 缩放与 320px 窄屏仍可操作；不能为了审计分数删功能、隐藏必要内容或弱化状态。没有已授权的可访问性债务。

图片有真实说明则使用该说明；否则使用可信文件名，绝不自动编造场景描述。按钮名称包含打开动作与文件名；相邻按钮文字已完整命名时，内部缩略图避免重复朗读。图标装饰隐藏于辅助技术。输入错误 `aria-describedby` 关联，必要错误用 alert，普通加载／结果／复制状态用 polite；不将整个图库设为 live region。

### Verification checklist · 验收要求

- [ ] 状态展示覆盖 Section 5 每个原语适用状态；无假 CID、假网关健康值或填充图库图片。
- [ ] 真实浏览器在 **375／768／1280／1600px** 检查媒体＋单一菜单、模态工具、菜单／来源／详情、2／3／4／5列相册、加载与失败；补查320px／320×240、CSS200%与Chrome200%分别留证、长路径、横屏、动态地址栏／safe-area。菜单48px，工具至少44px，真实hit不被裁切。
- [ ] 鼠标、触摸、纯键盘操作来源、菜单、工具、相册显隐、模式／筛选／网关／重试；实际portal焦点陷阱／归还、AX、IME、首尾导航、原生视频、double／pinch／pan／swipe、快速取消／迟到旧下载；保留截图、trace、geometry、网络与原始下载字节证据。
- [ ] 选缩略图返回正确阅读项，再开相册恢复滚动；断点与尺寸变化保留锚点；DOM／键盘顺序不按列重排。模式／overlay 不写存储、不改变公开 URL 协议。
- [ ] 屏幕阅读器检查揭示入口、名称、顺序、错误关联、busy 与合并播报；减少动态效果下信息与操作一致。实际文字、控件与焦点组合满足对比要求。
- [ ] 通过受控网络用例检查离线、慢请求、CORS、失效来源、单项损坏、非媒体、超长列表；真实网关波动单独报告，不能用假成功替代。
- [ ] 骨架优先保留可信尺寸，未知尺寸使用声明占位；首个阅读影像及时加载，相册按可见范围加载。只使用真实来源提供的预览／尺寸，不假设网关生成缩略图、转 AVIF 或调整大小。避免一次下载全部原图；有限预取不绕过验证或既有资源预算。
- [ ] 生产构建在本次运行拥有的空浏览器上下文中测试；不登录、不复用用户浏览器配置／cookie。以真实 Chrome 的 Playwright 所有权确认 CDP 端点运行 Lighthouse，**非 Lighthouse CLI**；移动与桌面各 3–5 次取中位数，四项 100 为目标，同时保留真实网关延迟的验证限制，不声称成绩已达标。
- [ ] 现有开发工具不泄漏生产包、页面和网络；检查 v1 白名单、默认不写、已存侧栏不自动开 overlay、URL 网关不隐式落盘、清除范围与 IO 失败降级。

**验证边界：** 本文交付设计约定，不交付 UI、组件、配置、依赖或精确接口计划。静态颜色对比不替代浏览器实测；断点、触摸／焦点、屏幕阅读器与性能须由对应运行证据验证，本文不宣称截图、审计或性能通过。
