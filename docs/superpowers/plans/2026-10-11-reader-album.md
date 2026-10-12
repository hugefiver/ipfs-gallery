# 阅读器与瀑布流画册

## 目标与交付边界

前端以真实影像为主体：默认进入电子阅读器式单幅阅读，媒体占满动态视口、保持比例；成功显示媒体后，所有非媒体工具默认隐藏为可主动唤出的悬浮层。通过菜单切换到手机相册式、按最短列排布的瀑布流画册。两种模式共享来源、筛选、当前项及验证后的资源池，不引入新的 URL 协议或持久化状态。

交付包含阅读器、画册、菜单和工具面板、可访问交互、既有能力的接入及对应验证。视觉令牌与组件状态遵循同期定稿的根目录 `DESIGN.md`；该文件由独立设计任务负责。此计划只定义最终产品要求、内部协作接口和完成证据，不授权本计划作者修改产品实现。

以下边界不可改变：

- 不修改 `src/core/`、`src/network/`、`src/worker/`、`src/shared/`，包括查询公开协议、验证流程、网关限制、预算、超时、取消和消息协议。
- 保留 `src/hooks/galleryPreferences.ts`、`useGalleryPreferences.ts` 的 v1 严格字段白名单、显式 opt-in、网关优先级和存储失败语义；不迁移、自动删除或自动改写记录。不保存 mode、CID、路径、item、搜索、滚动位置或浏览历史。
- `useGallery`、`GalleryController`、`AssetService` 和 `MainAssetSet` 是现有数据与资源边界，优先直接复用其接口，不另建媒体下载器或缓存池。
- 不更改 CSP、平台支持或内联样式许可；显式布局坐标沿用已有允许的样式机制。不绕过验证使用网关图片 URL，不新增分析、外部字体请求或服务。
- 不新增依赖，除非有实际必要且另获明确批准；不安装软件，不执行 Git 写入、发布或部署操作。
- 用户的 4173 预览及其进程、浏览器保持不动。验证使用独立构建目录和 4183 或本次运行拥有的空闲端口，不覆盖用户预览正在服务的 `dist/`。

## 数据接缝与状态所有权

`src/app/App.tsx` 是唯一的页面编排者。继续从 `useGallery({ gatewayPreference })` 获取 `location`、`snapshot`、`controller.assets`、`updateView`、`openItem`、`navigate`、`retry`、`cancel`、`rejectInput`；`filterItems` 和排序仍在这一层生成有序列表。`GalleryItem` 的稳定 `id`、`ref`、可选 `thumbnail`、标题、说明、标签、类型与尺寸直接复用，不扩展公共协议。

App 独占这些瞬态状态：

- `mode: 'reader' | 'album'`，新访问默认 `reader`。
- `chromeVisible`，默认 `false`；控件的显隐不写偏好。
- `panel: null | 'menu' | 'source' | 'filters' | 'info' | 'network'`；任一时刻最多一个面板。
- 当前来源会话下的画册书签、排序、通知与焦点归还目标。书签只留内存，换来源、取消或输入错误时失效。

`location.view.item` 继续表示主要选中项，不表示弹窗或模式。有效深链接、刷新及浏览器历史恢复后，以阅读器显示该项原始媒体；未指定 item 时选择筛选后首项。不存在或不符合当前筛选的 item 保留既有来源与筛选，提供真实提示及明确清除提示的动作，不悄悄改写 URL。筛选动作沿用保留仍匹配的当前项、否则选择首个匹配项的规则。

模式切换不调用来源重载、不改来源/筛选/item、不写 history。点击画册项只调用 `openItem(id)` 的 replace 语义并进入阅读器；不使用 `history.back()` 作为退出方式。分享继续由 `serializeLocation` 生成来源、筛选、网关和当前项，不包含 UI 模式。新来源提交仍由现有 `navigate` 的来源导航语义处理。

### 明确的默认行为

阅读器采用单幅，所有宽度一致，不因已保存 `layout` 或 `sidebar` 自动开启双幅、侧栏或控件。v1 中这些字段保留原值与合法性，仅本次阅读器不消费它们；不提供无效的布局开关。网络设置里的保存与清除仍执行现有、由用户明确触发的行为，准确说明哪些设置当前有效。菜单、面板和模式切换不能调用 `setLayout` 或 `setSidebar` 来同步 UI。

## 阅读器与悬浮交互

### 媒体舞台

- 阅读区覆盖可用动态视口，以 `100dvh` 和既有浏览器回退适配移动地址栏、安全区域及横屏。默认没有永久页头、标题、说明、导航、侧栏或页脚占位。
- 图片和视频在适配状态 `object-fit: contain`，不裁切、不拉伸、不强制固定比例。只有用户主动缩放后才允许在舞台内平移查看；复位恢复完整适配。
- 保留图片缩放、复位、拖动/触摸平移、单步上一项/下一项、左右方向键与未缩放状态下的横向滑动。首尾不循环，缩放或平移手势不能同时触发翻页或显隐。
- 视频通过验证后的 Blob 播放，`playsInline`、不自动播放；原生控制可实际操作，其点击、拖拽、键盘和触摸不冒泡为阅读器命令。不用透明大按钮覆盖媒体，尤其不能覆盖原生视频控件。
- 缩放、解码状态和手势在 item/会话变化时重置。原始媒体读取、解码失败与重试状态属于当前项，不能因迟到结果污染下一项。

### Chrome 与面板

- 成功显示媒体后的初始画面只有媒体。背景/图片上的单击或轻触、舞台聚焦时的 Enter、非编辑目标上的 M，切换非模态工具浮层。画册的空白区域也可唤出工具；点击画册项执行选择，不同时切换工具。
- 有意按 Tab 可以唤出工具并将焦点移到第一个可用控件；Shift+Tab 具有可预测的反向入口。舞台保留可访问名称及简短操作说明，使纯键盘和辅助技术用户能发现入口。
- 隐藏的工具卸载或使用正确的 hidden/inert 机制，同时退出 Tab 顺序和可访问树；不能只是透明。浮层本身不锁滚动、不设 `aria-modal`、不困住焦点。
- 不使用自动隐藏计时器。工具或面板内的焦点、表单编辑、视频操作和用户主动保持的工具状态不得被异步完成事件关闭；媒体加载完成也不覆盖用户已作出的显隐选择。
- Escape 首先关闭当前面板，归还到可见工具触发按钮；没有面板时再隐藏工具并将焦点归还舞台/画册容器。事件只处理一层，避免同一次 Escape 连带关闭两层。关闭工具前先移出即将隐藏的焦点。
- 阻止按钮、链接、表单、输入法组合、contenteditable、原生视频控件及面板事件触发全局媒体命令。指针取消、多指触摸、已发生拖动/平移/滑动的序列抑制随后 click；位移阈值在交互 helper 中集中定义并验证边界，不依赖计时猜测。
- 菜单可切换阅读器/画册，并能到达来源、筛选/排序、当前项信息、网络与浏览器偏好、分享。阅读工具可到达导航、缩放/复位、下载验证后的原始字节、复制 CID/原始地址和详情。通知在相关浮层或状态区域反馈，不留下常驻成功横幅。
- 所有真正模态面板共用 `NativeModal` 的 portal/showModal 路径，由 App 的单一 `panel` 状态决定。复用并验证滚动锁定、背景不可交互、Tab、Escape 和焦点归还。面板内容不再内嵌第二个 MUI Dialog；延迟加载的等待/失败内容留在同一个模态壳中。
- 面板关闭后回到其有效触发者；触发者因来源/筛选消失时回到当前模式容器。变更来源时不能把焦点归还旧缩略图。面板内部可滚动，320px 和 200% 缩放时关闭与恢复动作不被裁去。

### 初始、读取和错误

无来源时自动打开来源面板，这是默认隐藏的明确例外；无效查询/无效输入自动呈现正确错误并定位字段。有效提交后进入当前来源的读取状态浮层，提供取消；失败提供重试、编辑来源和网络设置。描述文件错误保留可用的按目录浏览入口。来源空、筛选无匹配、部分结果、未找到深链接和媒体解码失败分别呈现真实状态及恢复动作，不使用演示媒体、虚构进度或网关健康值。

来源提交、无效提交、取消、网关重新应用及历史恢复均清理旧会话的工具内容、通知、下载临时消费者、画册书签及文件租约；沿用 controller 的立即取消与失效机制。无效新输入必须保留用户的新草稿及其错误，不因重新挂载表单恢复成旧来源。普通模式切换不是来源变更，不能触发这些全量清理。部分结果的可用媒体仍可浏览，相关警告在状态浮层/菜单可达，不变成永久页头。

## 画册布局与资源行为

### 真正的最短列布局

画册使用一个独立、占满视口的滚动容器；DOM 始终按当前筛选/排序列表顺序生成项目。纯布局 helper 依次将每项放入当前高度最小的一列，同高时选较靠前列，返回绝对坐标和总高度。组件通过明确定位使用结果；不使用 CSS columns 的列优先阅读顺序，也不通过重排 DOM 实现瀑布流。

以下几何值为设计任务与实现任务的共同令牌约定；设计文档应在组件实现前包含这些值，JS 读取同一令牌来源，避免断点双份漂移：

| 令牌/条件 | 值与结果 |
|---|---|
| `--album-inset` | 视口 <768px 为 8px；768–1023px 为 16px；≥1024px 为 24px |
| `--album-column-3-min` | 实际内容宽度 640px |
| `--album-column-4-min` | 实际内容宽度 960px |
| `--album-column-5-min` | 实际内容宽度 1280px |
| `--album-gap` | 内容宽度 <640px 为 8px；640–959px 为 12px；≥960px 为 16px |
| `--album-fallback-ratio` | 4 / 3 |

内容宽度是容器扣除内边距、滚动条后的实际宽度，不是 window 宽度。小于第一个阈值为两列，此后依次三/四/五列。列宽为 `(width - gap * (columns - 1)) / columns`。因此 375px 两列、768px 三列、1280px 四列、1600px 五列；中间宽度随实际空间自然进入三/四列或四/五列。320px 仍无横向溢出。照片平直、按真实比例展示，常态不附永久文字卡片；标题作为真实可访问名称，选中标记及必要的视频类型标记不遮挡主体。

比例来源为有效元数据尺寸及已取得的验证资产尺寸；未知或不合法值使用稳定 4:3 占位，不为量尺寸下载全图库原图。缺乏完整尺寸时不捏造。可见资产加载后提供的可靠尺寸允许修正几何，但保留滚动锚点，防止当前阅读位置跳走。元数据或缩略图尺寸不能被标记为已验证原图尺寸。

每项是按 DOM 顺序可聚焦的选择按钮，有真实标题、当前项状态及可见焦点。键盘沿逻辑列表访问；焦点移到可视区外项目时将它滚入可视区并触发其按需读取，不采用与 DOM 顺序相矛盾的视觉方向猜测。

### 资源、取消与模式交接

- 继续复用同一个 `controller.assets`：128 MiB Blob 池、最多三个实际在途媒体任务、引用租约和失效规则不变。取消请求不代表提前释放在途槽位。
- 阅读器当前原图 priority 0；画册可见缩略图 priority 1；缺失/读取或解码失败后的验证原图回退 priority 2。`LIMIT`、`CANCELLED` 不触发更昂贵的原图回退。
- 可见范围由画册滚动根的 IntersectionObserver 决定；隐藏的工具或未进入的画册不挂载整图库资产消费者。没有 observer 时保留已有实测可见范围回退。视频缩略预览不自动播放。
- 离开模式时取消该模式专属 ticket、解除 observer 和事件监听，释放其租约；不销毁共享服务、不调用 `setSession`、不清空共享缓存。已验证资产在池中仍驻留时应直接复用，正常预算淘汰仍有效，不承诺无限缓存。
- 进入阅读器先停止画册消费者，再以 priority 0 取得当前原图；`MainAssetSet.update` 的低优先级预览释放行为可直接复用。离开阅读器通过 dispose 释放主项消费者，不能在画册挂载后额外调用 `update([])` 导致新缩略图被全局取消。
- 下载通过现有 AssetService 对当前原图取得独立短期租约，使用安全文件名和相同验证字节；成功、失败、切换来源及卸载均有清理，不因开始下载就转向未验证 URL。
- 画册保存内存书签：滚动位置、锚点 id/偏移、焦点项。切回画册恢复同一列表的锚点；当前项仍存在时恢复其选择与焦点，必要时最小滚动使焦点可见。列表或宽度变化后按稳定 id 重建坐标，不使用旧像素索引指向另一项。过滤掉当前项时退回新的当前项/容器，不异常聚焦。

## 内部 UI 接口与并行所有权

这些接口仅放在 `src/app/readerAlbumTypes.ts`，由 App 集成任务一次性建立；不放进 `src/shared/contracts.ts`。组件任务只导入，不互相改动文件。接口不包含查询解析、存储或网络实现。

```ts
type GalleryMode = 'reader' | 'album'
type GalleryPanel = 'menu' | 'source' | 'filters' | 'info' | 'network' | null

interface MediaContext {
  service: AssetService | undefined
  sessionId: string
}
interface ReaderAssetBinding {
  state: MainAssetState
  retry: () => void
}
// Reader 任务提供；App 每次渲染调用，enabled 仅在 reader 有当前项时为真。
useReaderAsset(
  context: MediaContext,
  item: GalleryItem | undefined,
  enabled: boolean,
): ReaderAssetBinding

interface ReaderSurfaceProps extends MediaContext {
  item: GalleryItem
  items: readonly GalleryItem[]
  asset: ReaderAssetBinding
  chromeVisible: boolean
  modalOpen: boolean
  onSelect: (id: string) => void
  onToggleChrome: () => void
  onOpenInfo: () => void
}
interface AlbumBookmark {
  collectionKey: string
  scrollTop: number
  anchorId?: string
  anchorOffset?: number
  focusId?: string
}
interface AlbumGridProps extends MediaContext {
  items: readonly GalleryItem[]
  activeId?: string
  collectionKey: string
  bookmark?: AlbumBookmark
  modalOpen: boolean
  onSelect: (id: string) => void
  onBookmark: (bookmark: AlbumBookmark) => void
  onToggleChrome: () => void
}
interface MasonryBox {
  id: string
  x: number
  y: number
  width: number
  height: number
}
layoutMasonry(
  items: readonly { id: string; ratio: number }[],
  width: number,
  columns: number,
  gap: number,
): { boxes: MasonryBox[]; height: number }
```

- `useReaderAsset` 由 Reader 任务放在 `src/hooks/useReaderAsset.ts`，内部复用 MainAssetSet；返回当前 session/ref 对应且仍 active 的借用状态。所有权留在 hook，App 和详情不能 release。未启用/切换会话不暴露旧状态；retry 只影响当前项。
- `ReaderSurface` 拥有解码、缩放、平移、滑动以及 reader 工具和下载临时消费者；只请求回调，不设置 mode/panel/query。App 从相同 `asset.state` 读取信息面板的已验证类型、字节数和尺寸，不另下原图。
- `AlbumGrid` 拥有布局、比例提示、可见项目消费者、滚动和卡片焦点；选择前记录书签并调用 `onSelect`。`collectionKey` 由 App 用 sessionId + 筛选 + 排序生成，不包含 mode、chrome 或当前 item，因此单纯选项/模式切换不丢书签。App 用 ref 接收高频书签，不引起整页滚动重渲染。
- App 独占全局 M/Tab/Escape、面板互斥和焦点归还；Reader 只处理舞台 Enter、方向键与媒体手势，Album 只处理卡片和背景交互。App 不重复处理已消费事件。模态打开时媒体交互停止；背景不产生新选择。

| 任务所有者 | 独占文件/范围 | 输出与依赖 |
|---|---|---|
| 设计 | `DESIGN.md` | 最终视觉、上述几何令牌、浮层/交互状态；不编辑代码、计划或测试 |
| Reader/media | 新增 `src/components/ReaderSurface.tsx`、`reader.css`、`src/hooks/useReaderAsset.ts`、`readerInteraction.ts` | 上述 Reader 接口、媒体行为；可读 Viewer/PreviewStage 提取行为，不编辑或删除原文件；不编辑 App/全局样式/测试 |
| Album/grid | 新增 `src/components/AlbumGrid.tsx`、`AlbumTile.tsx`、`album.css`、`src/hooks/masonryLayout.ts` | 上述 Album 接口和 layout helper；可读 MediaCard/useAsset 复用模式，不编辑原 MediaCard/AssetService/App/全局样式/测试 |
| App/overlay 集成 | `src/app/readerAlbumTypes.ts`、`App.tsx`、`app.css`，新 `GalleryChrome.tsx`/`GalleryPanels.tsx`，`NativeModal.tsx`、`LazyDialog.tsx`、`NetworkSettings.tsx`、必要 SourceForm/Filters/Primitives、主题令牌和 `index.html` 启动壳 | 建立共享接口，整合模式、面板、偏好入口、错误与焦点；独占旧 PreviewStage/ThumbnailSidebar/Viewer/MediaCard 和无用 UI helper 的最终清理；不得改数据/隐私边界 |
| 测试适配 | `tests/ui/`、`tests/e2e/`、`tests/audit/`、`tests/smoke/`、`tests/deployment/` 的受影响用例及 UI 测试 helper | 新行为和保留的真实数据断言；不编辑产品代码或测试配置，不改弱核心/网络/Worker/共享测试 |
| 父协调者 | Playwright 配置、验证运行与隔离产物目录 | 端口、独立构建路径、报告目录；任何配置编辑由此所有者集中处理 |

`reader.css`/`album.css` 使用各自命名空间，由对应组件导入；全局 tokens 仅集成任务修改。若共享接口确需等价调整，先由接口所有者统一变更并通知消费者，不能在两个分支发明近似类型。上述组件路径可在保持职责和接口不变时作最小调整，不扩展公共契约。

## 波次与可观察结果

### 波次一：共享契约与设计就绪

App 集成任务建立内部类型和瞬态状态边界；设计任务完成最终 `DESIGN.md`，对应令牌由集成任务映射至主题。明确可访问名称、单一模态壳、来源错误草稿所有权。结果是 Reader 与 Album 可独立实现，无需修改数据层或互相接管状态。

证据：内部接口可被两侧导入；设计与本计划的默认隐藏、单幅、画册列数及焦点要求一致。若设计产出与产品要求有实质冲突，由父协调者解决，不让组件自行猜测。

### 波次二：独立媒体与画册表面

Reader 与 Album 按接口并行开发；App 任务并行完成工具和面板内容，但不编辑子任务文件。测试任务可同时实现纯布局/交互 helper 的行为测试与共用 UI 驱动，稳定选择器后适配真实浏览器场景。

证据：Reader 的 contain、解码、导航、手势和原始下载可用；Album 的最短列几何、DOM 顺序、按需读取、回退和书签成立；模式专属消费者可释放，共享缓存不重建。

### 波次三：完整页面接入

App 接入两表面，统一单一 NativeModal，迁移现有来源/筛选/网络/隐私/分享能力到浮层，保持启动与无来源表单真实可用。产品能力接入完成后删除无调用的旧 UI 组件及其专属测试；仍被使用的公共 helper 和资产所有权测试保留。旧布局测试直接更新成有效的新行为测试，不增加“某组件已经删除”的存在性检查。

证据：从打开来源到纯媒体阅读、唤出工具、切画册、选择项、筛选、返回和恢复全部闭环；URL 与偏好记录没有新增 UI 状态；无永久 chrome，无嵌套模态，无遗留源码消费者。

### 波次四：真实表面与质量验收

测试任务完成全部相关 UI 用例适配；父协调者在隔离生产构建上运行集成与性能验证，修复问题由原文件所有者承担。有效未变的数据层测试可复用其结论，但本次新表面的证据必须来自本次构建。完成条件不是通过一个截图或类型检查，而是以下行为与保障均有可核查结果。

## 验收证据

### 确定性行为测试

- Masonry 对混合宽高比、未知/无效尺寸、同高列、空列表、各列数与断点计算给出无重叠、稳定顺序、正确总高；输入数据不被排序或修改。
- Reader 交互 helper 区分 tap、拖动、平移、横滑、pointercancel、多指、编辑目标和视频操作；缩放时不翻页，隐藏时控件不抢键。
- Reader hook/资源集在未启用、item/session 变化、迟到完成、错误重试、离开模式时只有正确消费者。保留资产复用、128 MiB、三个真实在途槽位、引用计数、主图优先和旧 Blob 失效测试。
- 偏好 v1、URL 优先级和所有存储 IO 失败测试不削弱；仅替换绑定旧页头/侧栏/查看器的 UI 操作。测试功能和协议字段，不锁文档、样式类名、任意提示措辞或删除组件的缺席。

### 真实浏览器视觉、输入与焦点

在 375/768/1280/1600px 及补充 320px、200% 缩放、短屏/横屏，使用真实生产页面采集默认阅读器、主动工具、各面板、画册和错误状态截图及几何：

- 加载成功默认隐藏；媒体边界在动态视口内、真实宽高比正确，无永久 header/caption/footer 的占位；工具开启不挤缩舞台。视频控制完整可用且没有自动播放。
- 画册各宽度满足列数，混合比例实际形成不等高最短列；滚动容器高度正确、无覆盖或横向溢出。DOM/键盘顺序与输入一致；尺寸更新和断点变化保持合理锚点。
- 鼠标、触摸和纯键盘走完整路径；Enter/M/Tab 的发现与开合、Esc 分层、首尾导航、缩放/平移/滑动、输入法、原生视频拖动不冲突。隐藏控制不在 Tab/AX 树中；面板 focus trap、背景 inert、焦点/滚动归还、懒加载失败均实际使用验证。
- reader → album → 选项 → reader → album 保留来源、筛选和当前项，URL 只按既有 item replace 更新，不增加历史退出；恢复画册位置和当前项焦点。无效或过滤深链接不偷偷改变来源或过滤器。
- 来源读取中修改为有效/无效新来源、连续取消与重试、面板打开时换会话、旧请求迟到均无残留媒体/错误/通知；新草稿错误准确。无来源面板可直接操作，状态浮层中的取消、重试、编辑和按目录浏览确实可达。

### IPFS、资源与隐私集成

继续使用 `tests/fixtures/unixfs.ts`、受控 trustless gateway 和现有真实字节断言，经真实 Worker/raw block/验证/exporter 路径覆盖 CID、多个根、目录/HAMT、JSON/YAML/TOML 描述文件、图片/视频、损坏块、网关失败回退及部分结果。

截图之外必须核对渲染 Blob 与下载文件的实际字节；缩略图与原图不是同一资产时核实阅读器/下载使用原图。观察请求日志：未进入画册和关闭工具不加载全图库，滚入可见范围才读缩略图；回退只发生在有效条件；快速切模式时取消 mode-only 请求并让原图优先，共享缓存命中不重复下载仍驻留资产。明确区分取消已发送与实际在途请求已结束。

浏览器存储检查覆盖默认零写入、已有 v1 记录不被模式/chrome 改写、显式保存/清除、URL 网关覆盖、存储访问/写入/删除失败；不得存储内容引用或悄悄删除用户记录。检查恶意元数据仍作为文本、已披露网关列表不扩张、媒体没有直连未经验证地址。

### 构建、部署与性能

使用已有依赖执行 `pnpm typecheck`、`pnpm typecheck:shared`、`pnpm lint`、`pnpm test`、`pnpm doctor:react`；开发阶段先运行受影响的 UI 测试，集成后运行相应完整集合。生产构建使用独立目录，例如父协调者确认项目路径后执行 `pnpm exec vite build --outDir .reader-album-build`，其 preview 使用对应 outDir 与 4183/独占端口。不要直接运行会覆盖 `dist/` 的默认 build。

父协调者统一配置 E2E、audit、smoke 的 baseURL/webServer 和报告目录；当前配置固定 4173，不能直接复用。部署用例目前读取 `dist/`，须由父协调者与测试任务对齐独立构建输入，保持 `/gallery/` 静态子路径、真实模块 Worker 和既有 CSP（包括现有 style inline 许可）不变。测试目录选择和配置只改变运行隔离，不降低断言。

真实公共网关 smoke 与受控网关回归分开报告；网络波动不能用假成功替代。生产包、页面与请求不得泄漏 react-grab/react-scan 等开发工具。

在本次运行拥有的空 Chromium profile/隔离上下文上，通过现有 Playwright 所有权确认的浏览器审计设施运行，不能用 Lighthouse CLI，也不能连接用户浏览器。新空态、已加载阅读器和实际通过菜单进入的画册均接受移动/桌面审计，各至少三次取中位数；画册场景应在同次测量导航/准备逻辑中真实进入，不增加公开 mode 参数。四类分数目标均为 100，同时记录报告中的性能瓶颈、React 渲染观测和测量限制。禁止为分数删除功能、降低可访问性或提前隐藏应可用内容。未达到目标或未测的表面必须明确报告，不能由其他页面或此前构建的成绩代替。

验证仅清理本次创建的浏览器、网关、preview、构建与报告临时资源，不按端口/进程名批量终止，不删除用户 `dist/`。交付报告包含截图/几何、功能结果、请求及字节证据、存储证据、部署结果和新性能中位数；未验证项目、真实网关限制或未满足的目标作为剩余问题明确列出。

## 风险与执行裁量

最需关注的是隐藏工具后的可发现性与焦点、原生视频事件被抢、模态嵌套、画册尺寸更新引起滚动跳动、模式交接重复消费者、来源错误草稿丢失，以及测试误连用户预览。以上均有对应接口边界和真实表面验收，不以静态代码检查代替。

当前无须追加产品决策：默认单幅、无自动隐藏计时器、v1 字段原样保留、最短列坐标和 4:3 未知比例已确定。实现者可在不改变接口/行为/预算的前提下选择局部 helper 拆分、等价定位机制与焦点恢复实现；视觉细节依最终 `DESIGN.md`。若必须改核心协议、数据/隐私保证、预算、持久化、平台安全策略、依赖或用户进程边界，停止并交父协调者取得明确授权。
