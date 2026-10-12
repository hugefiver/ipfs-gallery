# 大预览图库与浏览器偏好设置交付计划

## 目标、范围与完成条件

图库以一幅或两幅**大尺寸、完整验证的原始媒体预览**为主视觉，缩略图放在可隐藏侧栏中。桌面默认显示侧栏，移动端默认隐藏；主区根据自身可用宽度决定单幅或双幅。用户可明确选择将布局、分设备侧栏偏好及网关偏好保存到当前浏览器。

- 沿用中文暖纸色档案视觉、React/MUI 和现有 CSS，不新增依赖、安装软件或执行 Git 写操作。
- 保持目录／多 CID／描述文件来源、JSON/YAML/TOML、搜索／类型／AND 标签／排序、分享与来源历史、网关配置、下载、媒体详情和全屏功能。
- 保持核心查询语法、规范化、安全校验、Worker RPC、可信块获取、资源预算、取消、会话隔离与错误边界。`src/core/`、`src/network/`、`src/worker/`、`src/shared/` 的公共契约不变。仅调整应用层 `item` 的展示映射，不改变查询字段或解析规则。
- 没有未验证媒体直连、图像代理、服务端缩略图假设、隐藏网关、自动播放或媒体持久化。网关健康值继续来自实际请求。
- 完成意味着新布局、设置保存和原有可信读取能力一起通过真实浏览器验收；代码编译、成功日志或已有测试结果均不单独证明本次交付。
- 本文只定义最终交付，不向其他计划附加变更记录。布局与偏好采用本文要求，其余产品能力保持原有约束。

## 本地接口与实施边界

| 区域 | 可复用事实与约束 |
|---|---|
| `src/app/App.tsx`、`src/app/format.ts` | 入口拥有筛选、排序、失败提示；`filterItems` 产生最终顺序。主选项、侧栏和导航必须共用此顺序。 |
| `src/hooks/useGallery.ts` | 封装 URL、History API 和 controller 生命周期。应用层需区分 URL location 与送入 controller 的有效网关配置。 |
| `src/hooks/galleryController.ts` | 会话键由来源和有效网关决定；视图变化不重新发现来源。`start(..., true)` 会强制重建会话，不能用于选项或全屏切换。 |
| `src/hooks/assetService.ts`、`useAsset.ts` | 同会话／ContentRef 合并任务，提供引用计数 lease、优先级和有界缓存；优先级数值越小越先调度。取消在途任务不会提前释放并发槽。 |
| `src/components/MediaCard.tsx`、`Viewer.tsx` | 可复用验证后 Blob、解码状态、重试及下载行为；主预览必须取 `item.ref`，不把 thumbnail 当原图。 |
| `src/components/NetworkSettings.tsx` | 有网关草稿、应用／取消、默认值、统计和隐私说明；加入显式保存设置入口及真实持久化状态。 |
| `src/network/gateways.ts` | 直接复用 `normalizeGateway`；不另写简化 URL 校验器，也不为存储改变其规则。 |
| `src/theme/tokens.css`、`src/theme/theme.ts`、`src/app/app.css` | 保留既有颜色、字阶、44px 触摸目标、焦点和 reduced-motion 令牌，补齐主预览／侧栏尺寸。 |
| `tests/ui/behavior.test.ts` | 已覆盖资产引用、字节、缓存／并发上限、取消／过期结果及 controller 不因 view 改变重取来源；扩展这些真实行为接缝。 |
| `tests/e2e/`、`tests/deployment/`、`tests/audit/` | 受控 raw-block 网络夹具、真实 Worker、Blob 字节比较、静态 CSP 和浏览器审计是集成证据入口。 |

## 布局、选择与导航

### 主预览数量

- 桌面布局偏好为 `auto | single | dual`，默认 `auto`。移动端 CSS viewport 宽度 **≤767px 永远单幅**；不得被存储中的 `dual` 覆盖。
- 用主内容容器的实际 content-box 宽度 `mainWidth` 决策，扣除页面 padding、桌面侧栏及其间距后的主区才是测量对象。以 `ResizeObserver` 监听容器，不以 viewport 断点代替测量，不测量随当前面板数变化的子元素。
- `mainWidth >= 1100px`、非移动端、偏好不为 `single` 时允许两幅，否则一幅。`dual` 是优先双幅而非强制挤压；空间不足时单幅并附简短说明，保留所选偏好。未知测量值时先安全显示一幅。`auto` 和 `dual` 共享可读宽度安全线。
- 两幅时为筛选／排序序列的 `[activeIndex, activeIndex + 1]`；末项只显示一次，剩余单幅占满主区。不回填上一项，不复制末项，不额外请求第三幅。
- 侧栏开合、容器尺寸变化及横竖屏变化只改变实际布局，不改变活动项、不重取来源、不写存储。媒体变化前后预留稳定空间，`object-fit: contain`，长路径不撑宽页面。

### 缩略图侧栏

- 分为 `desktop`（≥768px）与 `mobile`（≤767px）两类偏好，默认分别 `true` / `false`。保存的是用户选择，不是推导出来的当前断点状态。
- 所有宽度均有可见且具名的侧栏开关。桌面侧栏作为独立可滚动列；手机为覆盖式 drawer，不压缩主预览。手机用户可主动打开，已保存的手机偏好可覆盖“默认隐藏”。
- 侧栏按最终筛选／排序顺序列出缩略图及真实文件名，活动项有非仅颜色的选择标记和语义状态。第二预览项不是另一个活动项。
- 点击缩略图选择其稳定 ID；手机选择后关闭 drawer 并归还合适焦点，此自动关闭不改写用户的持久侧栏偏好。侧栏隐藏时无可聚焦隐藏内容，不继续启动缩略图任务。
- drawer 有名称、模态语义、焦点陷阱、关闭动作、背景 inert 和滚动锁；桌面侧栏非模态。断点切换不得留下 inert、滚动锁或丢失焦点。

### 活动项、URL 与全屏

- 没有有效 `item` 时，活动项为第一个筛选结果；零结果没有活动项。有效 `item` 指向主预览活动项，**不自动打开全屏**。
- 初始 URL 的 `item` 不存在或被筛选排除时，不放宽筛选、不展示不匹配媒体；显示可关闭说明，主区可显示首个匹配项。关闭说明用 replace 移除无效 `item`，不调用 `history.back()`。首次有效选择后 URL 与主选项一致。
- 用户改变筛选导致活动项消失时，在同一次 view 更新中选择新结果首项或移除 `item`；排序改变而活动 ID 仍存在时保留活动项。不存在无效索引、残留第二幅或空列表越界。
- 缩略图、上一项／下一项、左右方向键每次移动 **一个**索引，即双幅时 `[i,i+1] → [i+1,i+2]`；首尾不循环。加载失败、类型不支持的条目保留位置及可恢复状态，不静默跳项；只有验证成功的媒体才进入 img/video。
- `item`、搜索、类型与标签等 view 更新用 replace，不创建一串浏览历史或重新发现来源；来源提交仍用 push，popstate 按真实 URL 恢复。保留 URL 中显式网关。分享链接包含当前来源／过滤／有效选择，不包含本地全屏状态或存储状态。
- 全屏为显式动作开启的应用内 modal，局部布尔状态驱动，不写新的查询字段或压入历史。点击第二幅的全屏动作先将该项设为活动项，再打开它；主区按新的活动项重算。
- 全屏使用相同 AssetService 会话／引用池，独立 lease 共享已验证 Blob；不创建第二套缓存，不重复请求相同原始媒体。全屏保留缩放、下载已验证字节、复制和详情能力。
- Escape 关闭最上层全屏／drawer／设置面板，不清除来源或退出应用；关闭全屏保留活动项和 `item`，返回触发按钮；触发项不再存在则回图库标题。避免叠加多个模态面板。
- 主区方向键只在图库浏览区域生效；输入、搜索、select、contenteditable、视频原生控制不被抢键。上一项／下一项和全屏按钮在手机上无需 hover 即可操作。
- 源切换／输入错误／取消立即释放旧媒体、关闭全屏、清空旧选项／错误／进度；过期请求、延迟观察器及旧 Blob 不能重新显示。新 session 的选择只来自新来源 URL 和新筛选结果。

## 媒体调度与资源保证

1. 主预览直接对 `item.ref` 调用现有有界服务，优先级 `0`；全屏及用户显式下载同为 `0`。原始 bytes 验证和 MIME 检查完成后才交给浏览器，视频完整验证后才能播放，默认不自动播放。
2. 侧栏实际可见行的真实 `item.thumbnail` 用优先级 `1`；无缩略图、缩略图读取失败或不能解码时，才对**仍可见**条目的原图以最低优先级 `2` 回退。不能对整张列表预取原图。观察根为侧栏滚动容器；隐藏侧栏禁用并释放缩略图消费者。
3. 主选项／单双方切换时先让离开的原图及低优先级侧栏消费者释放，再启动主预览；主面板请求先登记，不能只靠 DOM effect 顺序假定优先级正确。主面板请求落定前暂缓新增侧栏请求，失败也算落定，不能永久饿死侧栏。
4. 优先级不抢占已在途任务；取消后槽位继续计数直到完成。若侧栏 lease 挤占内存，应释放低优先级 lease，让既有 LRU 回收，并确保主预览可重试；不能放宽预算或错误地声称取消已腾出网络槽。
5. 两幅原图可能合计占满 128 MiB Blob 缓存。此时侧栏显示名称／占位和必要状态即可；低优先级预览不能使主图因 pinned thumbnails 失败，不能因内存压力循环重试。主区切换保留重叠项的现有 lease，释放退出项后加载进入项。
6. 原有上限继续生效：单媒体 64 MiB、Blob 缓存 128 MiB、最多 3 个媒体任务，以及共享 limits 中全部 Worker／块／输入预算。不得新增整图批量预取或 unbounded JS 字节缓存。
7. 两幅各自具有 loading、成功、unsupported、解码失败、读取失败与重试状态；一幅失败不抹掉另一幅。保留准确字节、类型、来源与 partial 语义，不能把 thumbnail 成功误报为原图加载完成。

## 浏览器偏好与稳定 API

### 存储契约

- 唯一应用拥有的 key：`ipfs-gallery.preferences.v1`；记录 `version: 1`。没有其他持久化项，未选择保存时不写入 localStorage。
- UI 提供显式复选项 **“保存设置到此浏览器”**，初始默认关闭；合法已存记录代表该浏览器曾选择保存，刷新后恢复开启。
- 仅保存布局模式、桌面／手机侧栏偏好和规范化后的启用网关列表。`gateways: []` 表示使用 `DEFAULT_GATEWAYS`，不是禁用所有网关。不保存禁用的编辑草稿行。
- 不保存 CID、媒体路径、item、过滤词／标签／排序、来源历史、媒体／Blob、认证信息或网关统计。存储 schema 白名单只重建允许字段，不将 ParsedLocation 或整个组件 state 序列化。
- JSON 字符长度不超过 40 KiB；读字符串先检查长度再 parse。严格校验 version、字段集合、对象形状、枚举和布尔值；网关最多 `DEFAULT_LIMITS.maxGateways`（8），每项先限 4096 字符再交给共享 `normalizeGateway`，规范化去重。拒绝未知字段／版本、污染键和错误类型，使用完整默认值，不部分采信坏记录。
- 获取 localStorage、getItem、JSON 解析、setItem、removeItem 均有异常边界。无存储／损坏／不可写时仍可在内存调整偏好；状态须区分未保存、成功、记录无效、不可访问、写失败及删除失败，不显示虚假“已保存／已清除”。不在每次 render 重试失败 IO。
- 开启保存立即写当前有效的**偏好快照**；之后只在用户偏好动作成功时保存。应用启动读取、自动布局、resize、移动端默认值、自动关 drawer、普通 URL 导航均不写入。
- 关闭保存立即停止后续写入并仅 `removeItem` 本 key，当前会话内存偏好可保留；“清除已保存设置并恢复默认”移除此 key、关闭保存、恢复布局／侧栏／网关偏好默认。不得 `localStorage.clear()` 或删除别的 key。
- 删除失败仍关闭本会话写入，明确提示磁盘记录可能在下次访问恢复，允许用户重试；不要伪造成功。无跨标签页同步需求，不添加后台轮询或其他存储通道。

### URL 网关与偏好隔离

有效网关优先级为：**有效 URL 显式 `gateway` > 会话内网关偏好（可由保存值恢复）> 默认网关**。无效 URL 显式网关仍报输入错误，不能偷偷换到保存值或默认服务。

- URL 覆盖只影响本次应用请求及设置面板显示，不自动写回偏好；即使已开启保存，访问一个分享链接、切换布局或侧栏也不能把链接网关永久保存。
- 开启保存立即保存本地偏好快照；URL 覆盖网关不是该快照的网关偏好。设置中说明当前网关来自分享地址，只有明确执行“应用”才将编辑器内有效网关晋升为偏好。
- 明确应用网关时先验证，再更新偏好和 URL／运行配置；已开启保存才写入。保存失败不使已验证的会话设置不可用，但显示其只在当前会话有效。取消编辑不改变偏好、URL 或存储。
- “恢复默认并应用”是网关动作：偏好置 `[]`，本次 URL 明确选择默认网关或移除覆盖并使用刚重置的默认偏好，不能复活旧保存网关。“清除已保存设置”是存储动作，不暗中覆盖 URL 显式网关；面板说明 URL 仍优先。
- `location` 保持 URL 原义；不在读保存设置时把其网关注入地址栏。另算 `effectiveGateways` 后构造 controller 输入，确保初次加载只请求最终选中的网关，不先请求默认网关再切换。
- 网络设置统计／隐私披露必须显示实际启用的 `effectiveGateways`。不把健康值与偏好合并保存。分享保留 URL 显式网关，不把未明确写入 URL 的私有浏览器偏好无提示加入分享链接。

### 模块接口（应用内部，不改共享公共类型）

`src/hooks/galleryPreferences.ts` 提供纯 schema／默认值／读写逻辑；`src/hooks/useGalleryPreferences.ts` 提供以下固定消费者接口。可调整内部实现，但下游开始接入后保持契约一致：

```ts
type LayoutMode = 'auto' | 'single' | 'dual'
type DeviceClass = 'desktop' | 'mobile'
type GalleryPreferences = {
  layout: LayoutMode
  sidebar: { desktop: boolean; mobile: boolean }
  gateways: string[] // [] = DEFAULT_GATEWAYS
}
type StoredGalleryPreferencesV1 = GalleryPreferences & { version: 1 }
type StorageStatus =
  | 'disabled' | 'saved' | 'invalid' | 'unavailable'
  | 'write-failed' | 'remove-failed'
type PreferenceResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'storage'; message: string }

interface GalleryPreferencesController {
  preferences: Readonly<GalleryPreferences>
  remember: boolean
  storageStatus: StorageStatus
  storageMessage?: string
  setLayout(mode: LayoutMode): PreferenceResult
  setSidebar(device: DeviceClass, open: boolean): PreferenceResult
  setRemember(enabled: boolean): PreferenceResult
  applyGateways(gateways: readonly string[]): PreferenceResult
  clearSavedPreferences(): PreferenceResult
}
// useGalleryPreferences(): GalleryPreferencesController
```

- 初始读取同步完成且无写副作用，React 重复初始化也不能造成持久化。返回值对象可只读消费，消费者不得直接修改数组或嵌套字段。
- `PreferenceResult.reason === 'invalid'` 不改变任何偏好；`'storage'` 表示已接受内存偏好但未成功完成持久化／删除，UI 不应将其解释成网关应用被拒绝。`remember` 表达保存意愿，`storageStatus` 表达实际结果。
- UI 集成：先调用 `useGalleryPreferences()`，再 `useGallery({ gatewayPreference: preferences.gateways })`。`useGallery` 额外返回 `effectiveGateways: readonly string[]`；原有 URL `location` 不被替换。传入偏好引用变化但值未变不能重建会话。
- `NetworkSettings` 增加 `preferences: GalleryPreferencesController` 与 `effectiveGateways: readonly string[]` props；保留 `open/location/stats/onApply/onClose`。网关草稿以有效值初始化；应用回调仍传经现有 query parser 校验的 `ParsedLocation`。
- `NetworkSettings` 的保存开关／清除动作立即生效，网关草稿仍需点应用。说明两者边界，取消按钮只取消尚未应用的网关草稿。
- 设置应用与 hook 偏好变更在同一次用户动作内协调，只以最终有效网关调用 controller；不能形成偏好、URL 两次中间重载。重试、取消、popstate 也使用最终有效网关，不绕过偏好解析。
- 主预览组件只消费布局／侧栏偏好和 setters，不调用 localStorage；设置模块不拥有活动媒体、URL view 或全屏状态。

## DESIGN.md 的最终视觉要求

以下内容应由具有产品文档编辑权限的执行方应用到根目录 `DESIGN.md` 对应章节，保留不受影响的颜色、字体、可信内容边界及可访问性要求。各章节直接描述最终状态，不附加发展过程或参考来源叙述。

### 信息顺序与表单

阅读顺序：精简页头与实际网关状态 → 紧凑来源控制与筛选 → 居中的大预览主区及可隐藏缩略图侧栏 → 主预览导航／详情／全屏入口。没有来源时显示完整来源表单与真实空态。图库载入后紧凑来源栏显示当前来源、编辑／更换入口、取消或重试；展开后所有来源模式和输入能力仍完整可用，输入错误应自动展开并定位字段。不能只为审计分数隐藏表单、筛选、警告或真实内容。

### 布局令牌及响应式

| Token | 最终值／规则 |
|---|---|
| `--content-max` | `1600px`，使宽屏可同时容纳侧栏及两幅大预览 |
| `--form-max` / `--measure-copy` | 保持 `800px` / `34rem` |
| `--sidebar-width` | `224px`，桌面固定侧栏宽度 |
| `--sidebar-drawer-width` | `min(320px, calc(100vw - var(--space-8)))` |
| `--preview-dual-min` | `1100px`，主内容容器 content-box 的双幅门槛 |
| `--preview-gap` | `var(--space-6)` |
| `--thumbnail-ratio` | `4 / 3`，仅缩略图／其骨架使用 |
| `--preview-stage-min` | `320px`，正常高度主舞台的基准最小高度；短屏／200% 缩放允许自然页面滚动，不裁去操作区 |
| `--preview-stage-max` | `800px`，结合 `100dvh` 与实际工具栏高度，避免媒体无限撑长 |
| `--layer-sidebar` | `30`，覆盖式侧栏；全屏沿用 `--layer-viewer: 40`；不允许与其他模态叠开 |

- 手机 ≤767px：主区一幅、侧栏默认隐藏、覆盖式 drawer；页面内边距 `space-4`，主预览间距 `space-4`，安全区有效，底部导航始终可操作。
- ≥768px：侧栏默认展示；页面 768–1023px 内边距 `space-8`、≥1024px 为 `space-12`；单／双幅只由可用主区宽度与用户偏好决定，而不是固定列数断点。
- 主区 `min-width: 0`，按行顺序一或两幅，无 masonry、三列媒体墙或固定主图 4:3 裁框。媒体以 contained 原比例居中；浅色 muted 仅作留边／等待态，全屏继续深底。
- 1280px 且侧栏展示时可以是一幅；收起侧栏后若主区达到 1100px 才变双幅。宽屏足够大时默认侧栏与双幅同时出现。不得为了截图预设双幅而压缩照片。
- 骨架、文件名和操作区保留尺寸；失败时同样保持主区结构。未知媒体尺寸不伪造元数据，不水平溢出。

### 原语与状态

| 原语 | 最终交互／验收状态 |
|---|---|
| 主预览舞台 | 一／两幅、loading、verified、unsupported、failed/retry、原始字节下载、focus、首尾、最后单幅；操作不嵌在整张可点击按钮中 |
| 缩略图侧栏 | open/closed、active、hover/focus、loading、thumbnail fallback、failed；仅可见项取媒体，名称始终可访问 |
| 布局控制 | auto/single/dual 单选语义；窄区／移动端说明实际单幅与所选偏好的区别 |
| 手机 drawer | 具名 toggle、打开聚焦、关闭／选择归还、Escape、焦点陷阱、背景 inert、旋转屏幕后清理 |
| 浏览器保存设置 | 默认关闭、已保存、关闭／清除、记录无效、访问／写／删除失败；错误与恢复动作相邻，状态不用颜色单独表达 |
| 全屏查看器 | 独立本地开合、共享已验证资产、键盘导航、媒体控制、详情／缩放／下载、焦点返回，无出应用历史动作 |

字体、颜色、触摸目标、focus-visible、平面分隔和 reduced-motion 规则继续沿用已有令牌。开合仅 opacity／transform，最长沿用 panel 180ms；无布局宽度动画。现有网格列数、主图统一 4:3、item 自动打开模态和强制首屏完整表单描述应由上述最终规则替代。文档验证章节表达本布局的验收条件，不声称项目为空或新布局已经过浏览器验证。

## 交付波次与文件所有权

### 波次 A：可独立验证的偏好与设置能力

**结果：** 上述固定 API 可消费，合法保存值可靠恢复，URL 覆盖不会成为持久化偏好，设置面板具备明确保存／清除／失败状态。

- 偏好叶任务独占 `src/hooks/galleryPreferences.ts`、`src/hooks/useGalleryPreferences.ts`、`src/components/NetworkSettings.tsx`、`tests/ui/preferences.test.ts`（新增）。这些文件不编辑 App、useGallery、共享模块或全局 CSS。
- 使用现有原语／设置样式，直接采用本文最终 props；由波次 B 的入口所有者完成消费端接线，不添加过渡 API。独立逻辑可先验证，完整类型检查与端到端设置验收须包括接线后的应用。
- 先交付最终接口、defaults、存储异常语义及纯逻辑测试证据，再由布局叶任务依赖接入；不需要两个任务同时编辑入口。
- 可用证据：默认不写、opt-in 立即写、重复加载只读、布局与两类侧栏存取、合法网关规范化、坏／超长／未知 schema、IO 异常、只删除本 key、隐私白名单。

### 波次 B：大预览／侧栏及应用集成

**结果：** 默认主预览可用，布局与侧栏按容器响应，顺序导航／URL／全屏正确，主媒体调度先于缩略图。

- 布局叶任务独占 `src/app/App.tsx`、`src/app/app.css`、`src/theme/tokens.css`、必要的 `src/theme/theme.ts`、`src/hooks/useGallery.ts`、`useViewerReturn.ts`、`useAsset.ts`、`assetService.ts`（仅必要 UI 资源调度）、`src/components/MediaCard.tsx`、`Viewer.tsx`、`SourceForm.tsx`、`PrimitiveShowcase.tsx`，以及新增主预览／侧栏／布局纯逻辑文件。不编辑偏好叶任务文件。
- 建议新组件 `PreviewStage.tsx`、`ThumbnailSidebar.tsx`，新纯逻辑 `src/app/previewLayout.ts`；保留本地命名习惯，可采用等价边界，不拆出无价值转发层。
- 接入波次 A hook 和 NetworkSettings props；应用层负责有效网关、URL、selection、局部全屏与来源重置。需要改偏好接口时由接口所有者协调，不各自猜测。
- 布局叶任务拥有 `tests/ui/previewLayout.test.ts` 及 `tests/ui/behavior.test.ts` 的资源／导航扩展；两个叶任务文件集合不重叠。文档令牌由调用方在 UI 实施前更新到 DESIGN。
- 可用证据：容器 1099／1100 边界、移动端强制单幅、桌面选项、最后一项、筛选变更、无效深链接、顺序移动、共享 lease、优先级、源切换与内存压力。

### 波次 C：真实界面、部署与质量闭环

**结果：** 实际新布局在各断点通过可信网络、交互、存储、无障碍与性能验证；失败／未覆盖项明确列出。

- 集成验证所有者独占 `tests/e2e/gallery-ui.ts`、`sources.spec.ts`、`interactions.spec.ts`、`responsive.spec.ts`、新增 `preferences.spec.ts`、`tests/deployment/static.spec.ts`、`tests/audit/lighthouse.spec.ts` 及必要测试配置。波次 B 主交互稳定后更新，不让并行叶任务争写这些文件。
- 只在需要区分 thumbnail 与 full-size 字节或顺序时扩展现有 deterministic fixture，不 mock Worker／broker／CID 校验。浏览器网络路由仍提供真实 CID 对应 raw blocks。
- 删除旧网格专属断言与其独占测试，更新最终 URL／全屏映射测试；保留获取、安全、错误、下载和资源回归。不给文档文本、已删除组件不存在、日志措辞加快照或字符串锁。
- 浏览器套件顺序执行，或为每次运行分配独立 `outputDir`、report 路径及端口；不得两个进程共用会被清空的产物目录。离屏缩略图需先打开侧栏并滚入对应滚动容器，再断言加载。
- Locator 限定具名主预览／侧栏／类型筛选组／设置 dialog，使用准确 role/name；不得依赖全页第一个 img 或宽泛“保存|应用”碰运气。

## 必需验收证据

### 行为与隐私

- 无保存状态首次加载：桌面侧栏显示，手机隐藏，auto 根据主区宽度变化；同 viewport 下仅改变可用容器宽度也能触发一／两幅。窄区的 `dual` 安全回单幅但偏好仍在。
- 1 项／2 项／末项／空结果，缩略图选择后主区原图字节匹配预期；两幅是相邻不同项，下一项只移动一位；图片与视频混合、失败项不跳过。
- 完整 bytes 与 thumbnail bytes 不同的夹具证明主区取原始资源；可见缩略图取 thumbnail，滚动／隐藏后停止请求；损坏 thumbnail 回退原图仍验证；网关损坏块不会显示在任何面板。
- 请求记录及资产单测证明主请求优先、共享引用不重复下载、三任务上限、128 MiB 边界和取消槽位语义。长列表／快速切换／隐藏侧栏／打开全屏后没有持续增长的引用或后台下载。
- 输入、搜索、type、AND tags、排序、复制分享、网关设置／取消／默认、重试、下载 bytes、全屏缩放／详情继续工作；仅视图和布局变化不重新 discover。
- URL `item` 进入主预览而非模态；返回／前进恢复来源与选择，直接深链接关闭提示／全屏不离站；Escape 及方向键不侵入表单／视频控制。输入错误或新源开始后没有旧媒体闪回。
- opt-in 后刷新恢复 layout、两类 sidebar、gateway；未 opt-in 的修改刷新不保留。自动 resize／drawer 自动关闭不产生存储写。空浏览器上下文验证默认值，reload 使用同一测试 context 验证保存。
- URL 网关 A 覆盖保存偏好 B 时实际只请求 A，单纯打开链接／切布局／切侧栏／开保存不把 A 写入；明确应用后才保存 A。移除 URL 覆盖恢复 B（或明确应用后的新偏好），非法 URL 网关 fail closed。
- localStorage 的 getter/get/set/remove 分别失败、JSON 损坏、过大、版本错误及非法网关都有真实降级状态。关闭保存／清除不影响放入的无关测试 key；删除失败诚实报告下次可能恢复。
- 检查实际存储内容及网络行为，证明没有内容引用、过滤词、item、媒体、历史、认证或统计泄漏；验证不是只检查一段隐私文案。

### 真实界面与部署

- 截图与交互：375／768／1280px，并增加足以在侧栏展示时容纳双幅的宽屏（如 1600px）；另查 320px、200% 缩放、767／768 边界、横屏／短屏、长文件名和 reduced-motion。
- 每个关键状态覆盖空态、载入、单幅、双幅、侧栏显示／隐藏、手机 drawer、部分失败、原图错误、设置保存／失败、全屏；验证主预览为首要视觉、无横向溢出、紧凑来源功能可达。
- 鼠标／触摸／纯键盘验证真实焦点、44px 目标、drawer/modal trap 与 return、inert 清理、首尾禁用、视频控件、屏幕阅读器名称／播报。截图不能代替交互证据；缺少屏幕阅读器实测时说明限制。
- 静态 `/gallery/` 子路径的桌面／移动端生产部署，维持严格 CSP、Worker／Blob 交付和资源路径；不放宽 CSP 来解决布局问题。
- 使用运行拥有的隔离空浏览器上下文，不登录或复制用户 cookie／配置／storage。只清理本次创建的测试浏览器、网关进程、监听器和临时资源。

### 性能与验证命令

沿用当前 package scripts，PowerShell 中分别执行并检查退出状态，不安装新工具：

```powershell
pnpm typecheck
pnpm typecheck:shared
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
pnpm test:deployment
pnpm audit:browser
pnpm doctor:react
```

- 开发中先运行受影响单测；最终源码稳定后做完整类型／lint／unit／build，随后针对同一生产构建执行浏览器套件。保留失败证据，不删除或弱化相关检查以换取通过。
- Lighthouse 使用现有 Playwright 所有权验证过的真实 Chromium/CDP 审计入口，非 Lighthouse CLI；**empty 和 loaded × mobile 和 desktop，各三次取中位数**，保存每次 JSON、截图、请求及汇总。目标四类均 100，不降低既有目标。
- loaded 审计等待实际可见主面板的**原始媒体验证并解码**，数量按真实一／两幅与剩余条目判断，不能用任意三个 img 作为就绪条件，也不能使用 skeleton、假图或测试专用简化页面。
- 保留实际 Worker、完整性校验、真实应用 UI、主预览大图和默认侧栏策略；不通过隐藏工具、降低验证强度或删除交互提高分数。观察 React renderer／commit 流，检查开发工具没有进入生产页面与网络。
- 受控夹具证明确定性行为，不声称公共网关延迟或可用性因此被证明。公共烟测沿用现有脚本可单独运行并如实报告网络限制，不影响可信读取的安全约束。

## 风险与交付报告

- **资源竞争：** 双原图与侧栏同时持有 lease 是主要内存风险；用任务优先级、释放消费者和已有预算验证，不提高上限。
- **网关启动顺序：** 偏好读取必须先于首次 discover，URL 原义与有效运行配置分开，避免泄露到非选中网关。
- **持久化失败：** 浏览器可能拒绝访问／配额写入／删除；内存可用与磁盘成功是不同结果，不能承诺下次一定恢复或清除。
- **响应式焦点：** 移动 drawer 变桌面侧栏及全屏关闭都需要还原 inert、滚动与焦点；状态切换不写自动偏好。
- **验收可信度：** 离屏懒加载、歧义定位器和共用产物目录可能让测试结论失真；必须用正确最终行为和隔离运行重新取证，不能仅从失败数推断产品缺陷。
- 本次布局与存储能力在实现和运行之前均属待验证。交付报告列明实际修改、接口、通过／失败／未覆盖的验证、证据路径以及必要外部网络限制；不把既有构建结果当作新布局通过。
