# IPFS Gallery 产品交付计划

## 目标与交付边界

交付一个可由静态站点托管的纯前端 IPFS 图库：Vite、TypeScript、React、MUI、pnpm，采用执行时最新稳定且相互兼容的依赖版本。用户可以通过 URL 或表单打开 UnixFS 目录、多个 CID、显式图库描述文件；浏览器 Worker 使用 IPFS 生态组件获取并验证数据，多网关自适应回退，中文桌面与移动端 UI 展示真实内容。交付完整交互与可靠性，不缩减为演示版。

- 项目根目录：`C:\Users\hugefiver\source\ipfs-gallery`。规划时目录为空，没有现成代码、测试、构建配置或 Git 仓库。
- 已授权项目级包安装与浏览器测试；不安装全局工具，不初始化 Git，不 commit/push，不依赖账户、后端、API 密钥或用户浏览器资料。
- `DESIGN.md` 由独立前端设计工作提供，是 UI 实现前置输入；中文、温暖编辑式视觉、响应式内容优先。本文不替代或重复其 token 定义。
- 生产运行不得依赖测试网关、Node 服务或远程图片代理。测试服务器只用于开发验证。
- Rust/WASM 不是默认依赖；只有性能证据证明现有浏览器组件不能满足明确需求时，才提出必要性与接口方案，不为此扩充范围。
- 交付源码、锁文件、生产静态构建、功能测试、浏览器测试、真实网络烟测结果，以及 README 中的使用、部署、查询、描述文件格式、安全与资源限制说明。测试结果必须区分实测、失败和未验证。

## 技术边界与执行前必须确认的事实

目标数据路径：React → 类型化 Worker RPC → 图库服务 → `ipfs-unixfs-exporter` reader → CID 校验的自适应 raw-block broker → 已配置 HTTPS 网关。块完整校验后才交给 exporter；重建的媒体字节传输到主线程生成 Blob URL。不得以未验证的远程 `<img src>`、媒体 URL、普通网关文件响应或 HTML 网关预览替代。

首选直接使用 `ipfs-unixfs-exporter`，不需要启动 Helia 节点。broker 的 `get` 保持 `Promise<Uint8Array>`，在 `src/network/reader.ts` 内适配所选当前 exporter 版本的生成器式 blockstore `get`：先 await 完整 CID 校验，再 yield 已验证字节（一个块或其分段），绝不边接收未验证网络字节边 yield。结合外部 API 研究与当前稳定版声明文件，完成真实浏览器 Worker 技术验证：

1. 可以通过一个受控 broker 获取 raw 与多块 dag-pb UnixFS 数据，所有网络块必经 CID 校验；没有绕过 broker 的默认网关、delegated routing 或隐式网络通道。
2. 浏览器 Worker 能导入所需模块，不依赖 Node polyfill；支持文件内容读取、目录枚举、路径解析与标准 HAMT 分片目录，取消信号能停止底层 fetch。
3. 错误网关返回损坏块时不会污染缓存，能切换到另一网关继续；目录元数据和文件正文均在同一验证链内。
4. 确认 exporter 的 blockstore get 生成器形状、取消传播与 codec 支持；不手写 UnixFS/HAMT 解码器，不强制覆盖不兼容的 peer dependencies。

`@helia/http` + `@helia/unixfs` 是满足相同可信读取接口的有效备选，但不是必要依赖。若首选组合存在实际兼容阻塞，再由协调者根据证据选用备选；不能改成不可信网关渲染。本计划不声明安装、兼容性或浏览器验证已经通过。

## URL、来源与状态契约

所有来源字段与表单共用 `normalizeContentRef(value: string): ContentRef`，接受裸 CID、`CID/path`、`ipfs://CID/path`，以及粘贴的 HTTP(S) 网关 `/ipfs/CID/path` 链接。网关链接只提取内容引用：不采用其 host、凭据、查询或 fragment，不把它添加到配置，也不请求原 URL。其它 HTTP 媒体链接、IPNS 与任意 URL 不接受。CID 使用 `multiformats` 解析并规范化；解析前不能把 CID 主体任意转为小写。

外层查询由 `URLSearchParams` 解码一次；嵌套 URI 的 pathname 分段再按 URI 语法解码一次，不循环解码。裸 `CID/path` 的 path 按文字处理。拒绝分段解码产生的路径分隔符或非法字符，序列化分别编码内层 URI 与外层查询；包含逗号的路径使用重复 `cid` 而非逗号列表。canonical 来源表示为 `ipfs://<规范CID>/<逐段编码路径>`，使特殊字符可往返。

| 参数 | 格式与含义 |
| --- | --- |
| `cid` | 可重复，每项一个可归一化内容引用 |
| `cids` | 可重复，每项以英文逗号分隔的内容引用；忽略首尾空白，拒绝空 token |
| `unixfs` | 单个可归一化引用，按目录或文件自动识别 |
| `meta` | 单个可归一化引用，强制按描述文件读取 |
| `gateway` | 可重复的 HTTPS 网关基地址，不含凭据、查询、fragment；支持合法路径前缀 |
| `browse` | 可选单值 `1`；跳过目录自动 metadata 发现，不覆盖显式 `meta` |
| `q` | 搜索词，最长 200 个字符 |
| `tag` | 可重复标签过滤；组合采用 AND |
| `type` | `image` 或 `video`；省略表示全部 |
| `item` | 打开的媒体稳定 ID，用于 viewer 深链接；未知 ID 不改变图库，显示可关闭提示 |

来源优先级固定：`meta` > `unixfs` > 所有 `cid`/`cids`。同级 `meta` 或 `unixfs` 重复属于输入错误；高优先级来源出现时不请求低优先级来源，并提示被覆盖输入。`cid`/`cids` 按参数出现顺序展开、按规范 ContentRef 去重，最多 100 个来源。无来源显示真实空状态，不自动加载假图库。无效来源显示输入错误，不偷偷尝试别的来源。

`?unixfs=<CID>/album` 表示打开目录或文件并自动识别；`?meta=<CID>/album/gallery.yaml` 表示严格使用描述文件；`?cid=<CID1>&cid=<CID2>` 与 `?cids=<CID1>,<CID2>` 表示多个内容根。README 提供可复制的格式示例和测试生成的有效 fixture 使用方式，不把占位 CID 当成真实示例。

路径按分段规范化：拒绝 NUL、反斜杠、空中间段、超长段；允许描述文件相对路径中的 `.`/`..` 正常解析，但不能越过 CID 根。URL 引用最多 64 个分段、4096 字符；单 CID 根内路径用 `/` 拼接，网关请求时逐段编码。不得借助 URL 解析把相对内容路径解释为网络地址。

表单提交通过同一解析器生成 canonical URL，导航仅使用 History API，不需要服务端路由。搜索与过滤更新 URL 使用 replaceState（输入防抖）；来源提交和打开 viewer 使用 pushState；关闭自己压入的 viewer 返回前一状态，直接打开的深链接关闭时移除 `item`，不得把用户送出应用。popstate 重建 UI；仅来源/网关改变才创建新数据 session，搜索、过滤、viewer 导航不重取整个图库。分享 URL 保留来源、显式网关及当前视图状态，不包含运行时统计。

提交或导航到新来源时，立即取消旧 session、关闭 viewer、清空旧图库/错误/进度并释放其媒体引用；显示新来源的 loading，解析或加载失败则显示新来源错误，不保留旧图库充当当前结果。输入草稿未提交不触发切换；当前图库内部单项重试不清空成功项。

## 描述文件与目录发现

### 版本 1 数据格式

JSON/YAML/TOML 共享以下语义；UTF-8，最多 1 MiB，顶层对象，拒绝未知 schema 版本与未知字段，所有字段经过运行时验证。YAML 禁用自定义标签与别名展开；所有格式拒绝原型污染键。解析器输出先检查深度/节点/数组预算，再规范化。

```ts
interface GalleryManifestV1 {
  version: 1
  title?: string               // <= 200 字符
  description?: string         // <= 4000 字符，纯文本
  items: ManifestItem[]         // 0..2000
}
interface ManifestItem {
  cid?: string                 // 裸 CID；与 path 至少一个存在
  path?: string                // 有 cid 时相对该 CID；否则相对描述文件父目录
  title?: string               // <= 200
  alt?: string                 // <= 1000
  type?: 'image' | 'video'      // 提示，不能覆盖真实文件类型检查
  tags?: string[]              // <= 20，每项 <= 64
  width?: number               // 正整数，<= 16384
  height?: number              // 正整数，<= 16384
  thumbnail?: { cid?: string; path?: string } // 同样的引用规则
}
```

`width`/`height` 必须同时提供；实际媒体类型和尺寸仍须验证。标题、alt、描述只作为文本输出，不解释 Markdown/HTML。同内容多项允许保留不同编辑信息；稳定 ID 由来源引用、条目序号及规范化内容引用生成，不取随机 UUID。显式 metadata 裸文件 CID 没有可寻址父目录，此时所有条目/thumbnail 必须自带 CID，不能猜测相对位置。thumbnail 同样只允许 IPFS 引用并需验证，不允许 HTTP/data/javascript 源。

### 识别与遍历行为

- `meta` 明确指定：读取验证后的字节；有 `.json`、`.yaml`、`.yml`、`.toml` 扩展名时只使用对应解析器。无扩展名/未知扩展名时，以 JSON → TOML → YAML 尝试，只有通过完整 version 1 schema 的结果才算成功。各解析器仍受同一资源预算约束。无有效结果显示 metadata 错误，不回退为普通媒体。
- `unixfs` 或其它内容引用：先通过标准 UnixFS 库确定目录/文件/raw；不得把无扩展名 CID 直接当图片。文件从有上限的已验证前缀识别媒体魔数；小文件也可尝试通过完整 schema 识别 metadata。普通文本/不支持的 codec 产生可理解的 unsupported 结果，不交给浏览器执行。
- 每个选中的目录根按 `gallery.json`、`gallery.yaml`、`gallery.yml`、`gallery.toml` 顺序探测直接子项。第一个存在的候选是唯一权威描述文件；若损坏，则报告错误并提供显式“按目录浏览”动作，不自动跳过错误挑另一个文件。该动作须在可分享状态中表达：增加单值 `browse=1` 参数，仅对目录自动 metadata 发现生效，不覆盖显式 `meta`。
- 未发现描述文件或使用 `browse=1` 时，以受限递归列出媒体；标准库负责 HAMT 分片枚举，不能把 shard 链接展示为目录。遍历不跟随 symlink，记录警告；递归扫描期间不解释子目录描述文件，以免覆盖或重复集合。
- 多 CID 各自按上述规则解析，稳定地按输入根顺序、每根路径排序合并；一个根失败不抹掉其他根，显示 partial 与逐根错误。显式 meta 失败则是整个请求失败；单目录 metadata 失败也不隐式吞掉。
- 拓展名用于候选排序、不能替代魔数校验；无扩展名文件通过前缀识别。目录扫描可产出待验证的候选项，真正媒体加载仍必须校验类型。根列表的重复引用去重；同一目录不同路径的同 CID 文件可以保留，使用祖先 CID 集合防循环而非全局删掉合法重复路径。

## 稳定模块与跨 Worker 合约

协调者先完成并冻结 `src/shared/contracts.ts`、`src/shared/limits.ts` 和接口契约测试，再并行分配 core/network/UI。这里“冻结”表示各 worker 共享同一接口版本；实施中的修改须由接口所有者同步消费者，不由单个 worker私改公共类型。

```ts
export type ContentRef = { cid: string; path: string[] }
export type Source =
  | { kind: 'manifest'; ref: ContentRef }
  | { kind: 'unixfs'; ref: ContentRef; browse: boolean }
  | { kind: 'cids'; refs: ContentRef[]; browse: boolean }
export interface GalleryInput { source: Source }
export interface ViewState { q: string; tags: string[]; type?: 'image' | 'video'; item?: string }
export interface ParsedLocation {
  input?: GalleryInput
  view: ViewState
  gateways: string[]
  notices: string[]
}
export type MediaKind = 'image' | 'video' | 'unknown'
export interface GalleryItem {
  id: string
  ref: ContentRef
  thumbnail?: ContentRef
  title: string
  alt: string
  tags: string[]
  kind: MediaKind
  width?: number
  height?: number
  sourceLabel: string
}
export type ErrorCode = 'INVALID_INPUT' | 'INVALID_METADATA' | 'UNSUPPORTED'
  | 'NOT_FOUND' | 'NETWORK' | 'INTEGRITY' | 'TIMEOUT' | 'LIMIT' | 'CANCELLED'
  | 'INTERNAL'
export interface GalleryError {
  code: ErrorCode
  message: string
  retryable: boolean
  ref?: ContentRef
  gateway?: string
}
export interface GalleryResult {
  title: string
  description: string
  items: GalleryItem[]
  warnings: GalleryError[]
  partial: boolean
}
export interface GatewayStat {
  url: string
  state: 'healthy' | 'cooldown' | 'probing'
  ewmaMs?: number
  inFlight: number
  successes: number
  failures: number
  cooldownUntil?: number
}
export interface SessionConfig { gateways: string[]; limits: ResourceLimits }
export interface ResourceLimits {
  maxRoots: number; maxGateways: number
  maxManifestBytes: number; maxManifestDepth: number; maxManifestNodes: number
  maxItems: number; maxDirectoryDepth: number; maxDirectoryEntries: number
  maxBlockBytes: number; maxAssetBytes: number; maxImagePixels: number; maxMediaDimension: number
  maxBlockConcurrency: number; maxGatewayConcurrency: number; maxAssetConcurrency: number
  maxBlockCacheBytes: number; maxBlobCacheBytes: number; maxAssemblyBytes: number
  maxDiscoveryInputBytes: number; maxAssetInputBytes: number
  gatewayTimeoutMs: number; blockTimeoutMs: number; discoveryTimeoutMs: number; assetTimeoutMs: number
  progressIntervalMs: number; telemetryIntervalMs: number
}
export interface VerifiedAsset {
  bytes: ArrayBuffer
  mime: string
  kind: 'image' | 'video'
  byteLength: number
  width?: number
  height?: number
}
export type WorkerRequest =
  | { type: 'discover'; sessionId: string; requestId: string; input: GalleryInput; config: SessionConfig }
  | { type: 'asset'; sessionId: string; requestId: string; ref: ContentRef }
  | { type: 'cancel'; sessionId: string; requestId: string; targetRequestId: string }
  | { type: 'dispose'; sessionId: string; requestId: string }
export type WorkerResponse =
  | { type: 'result'; sessionId: string; requestId: string; op: 'discover'; value: GalleryResult }
  | { type: 'result'; sessionId: string; requestId: string; op: 'asset'; value: VerifiedAsset }
  | { type: 'result'; sessionId: string; requestId: string; op: 'cancel' | 'dispose'; value: null }
  | { type: 'error'; sessionId: string; requestId: string; error: GalleryError }
  | { type: 'progress'; sessionId: string; requestId: string; phase: 'resolving' | 'listing' | 'metadata' | 'media'; completed: number; total?: number }
  | { type: 'telemetry'; sessionId: string; requestId: string; gateways: GatewayStat[] }
export interface GalleryClient {
  discover(request: Extract<WorkerRequest, { type: 'discover' }>): Promise<GalleryResult>
  loadAsset(request: Extract<WorkerRequest, { type: 'asset' }>): Promise<VerifiedAsset>
  cancel(request: Extract<WorkerRequest, { type: 'cancel' }>): Promise<void>
  dispose(request: Extract<WorkerRequest, { type: 'dispose' }>): Promise<void>
  subscribe(listener: (event: Extract<WorkerResponse, { type: 'progress' | 'telemetry' }>) => void): () => void
}
```

- `ResourceLimits` 对应下节所有预算，由共享模块导出；UI 不能通过 URL 提高安全上限。Worker 校验消息形状与上限，不直接信任主线程输入。
- `discover` 开启一个 session，Worker 同时最多一个有效 session；新 discover 原子取消旧 session 的全部工作。asset 必须引用活动 session；网关设置更改重新 discover。requestId 在客户端生命周期唯一。
- 每个 WorkerRequest 恰有一个终结 result/error；progress/telemetry 不是成功证据。取消目标未完成时以 CANCELLED 终结，取消指令另有 result；已经完成的目标是幂等 no-op。dispose 取消挂起请求并返回 result，客户端随后 terminate Worker。Worker 崩溃时 client 结算全部 pending Promise 并允许重建。
- Worker 错误只传可序列化数据，不能依赖 Error 对象/stack clone。asset 只返回精确长度的独占 ArrayBuffer，并在 transfer list 中转移所有权；不得转移缓存共用 buffer。相同 CID 的进行中块读取可共用，但引用计数使单个消费者取消不误杀其他消费者，最后消费者取消才中止 fetch。
- 主线程对照 sessionId/requestId 丢弃陈旧事件与结果，不给旧媒体创建 Blob URL。client 对已发送但未消费终结结果的 asset 请求统一限流，跨 session 仍最多 3 个；取消后不能在目标真正终结前释放该名额。主线程同步把成功结果放入有界 Blob 缓存或丢弃后，才安排下一资产，不另建无界结果队列。关闭 viewer 取消专属任务，离屏取消未开始的任务。
- `src/core/query.ts` 导出 `normalizeContentRef(value: string): ContentRef`、`parseLocation(search: string): ParsedLocation`、`serializeLocation(location: ParsedLocation): string`。非法值抛出携带 GalleryError 的 domain exception，无来源仅返回 input 缺省。
- 网络与 core 使用下列精确接口。reader 将 exporter 的库类型封装在内部；不向 UI/core 泄露 exporter 或 Helia 类型。

```ts
// src/network/types.ts
export interface VerifiedBlockSource {
  get(cid: string, signal: AbortSignal): Promise<Uint8Array>
  snapshot(): GatewayStat[]
  dispose(): void
}
export interface BrokerDependencies {
  fetch: typeof globalThis.fetch
  now: () => number
  random: () => number
}
// src/network/broker.ts
export function createGatewayBroker(config: SessionConfig, dependencies: BrokerDependencies): VerifiedBlockSource

// src/core/types.ts
export interface ContentStat { kind: 'file' | 'directory' | 'symlink'; size?: bigint }
export interface ContentEntry extends ContentStat { name: string; ref: ContentRef }
export interface ReadOptions { signal: AbortSignal; maxBytes: number; offset?: number; length?: number }
export interface ContentReader {
  stat(ref: ContentRef, signal: AbortSignal): Promise<ContentStat>
  ls(ref: ContentRef, signal: AbortSignal): AsyncIterable<ContentEntry>
  read(ref: ContentRef, options: ReadOptions): AsyncIterable<Uint8Array>
}
export type GalleryProgress = Pick<Extract<WorkerResponse, { type: 'progress' }>, 'phase' | 'completed' | 'total'>
export interface OperationOptions { signal: AbortSignal; limits: ResourceLimits }
export interface DiscoveryOptions extends OperationOptions { onProgress?: (event: GalleryProgress) => void }
// src/network/reader.ts — 每个操作独立创建，输入预算不互相串扰
export function createContentReader(source: VerifiedBlockSource, options: { maxInputBytes: number }): ContentReader
// src/core/gallery.ts
export function discoverGallery(input: GalleryInput, reader: ContentReader, options: DiscoveryOptions): Promise<GalleryResult>
// src/core/media.ts
export function readVerifiedAsset(ref: ContentRef, reader: ContentReader, options: OperationOptions): Promise<VerifiedAsset>
```

reader 只交付已校验块重建的内容，强制执行 `read.maxBytes`；`offset/length` 以文件字节为单位。每次 discover/asset 使用独立 reader，其 `maxInputBytes` 分别取共享限额中的 discovery/asset 输入预算，所有 stat/ls/read 与缓存命中累计计数。broker 可以跨这些操作共享已验证缓存。注入的时钟/随机源用于确定性调度测试。

- `src/worker/client.ts` 导出 `createGalleryClient(workerFactory?: () => Worker): GalleryClient`，默认工厂创建 Vite module Worker。上面所有 Promise 以统一 domain exception 拒绝，携带 GalleryError；subscribe 返回 unsubscribe。方法显式接受 session/request identity，由单一 UI session controller 分配。dispose ack 后 terminate，实例不再复用；新 session 在同一存活实例调用 discover 即可。UI 不直接操作 postMessage。

### 文件所有权

| 所有者 | 文件边界与产物 |
| --- | --- |
| 基础/整合 | package.json、pnpm-lock.yaml、Vite/TS/测试配置、src/shared/*、src/worker/*、src/main.tsx、测试 fixture、README |
| network | src/network/{broker,verify,cache,reader,types}.ts 及同域测试；实现 VerifiedBlockSource、ContentReader 适配器 |
| core | src/core/{query,manifest,paths,gallery,media,types}.ts 及同域测试；不导入 React、MUI 或浏览器 UI |
| UI | src/app/*、src/components/*、src/hooks/*、src/theme/*；消费 shared/client，不修改 broker/core |

network 与 core 对 `ContentReader` 的所有权由整合者在并行前落实；初始 `core/types.ts` 属接口基础，后续不得两边同时修改。端到端测试、全局样式与 App 挂载由整合者协调。测试通过注入 reader/broker fixture 解耦，不将模拟实现发布为默认产品内容。

## 多网关、安全与资源策略

### 可信读取与负载均衡

- 默认至少三个明确支持 CORS 与 raw-block 响应的 HTTPS 公共网关，名单根据 API 研究和执行时实测确定并集中配置。失败/受限要如实暴露，不能把所有公共服务可用作为确定性测试前提。
- 显式 `gateway` 列表替换默认列表，最多 8 个；设置面板可编辑、启停与恢复默认，并披露当前启用列表。broker 在这些已披露网关之间自动均衡和失败回退，不逐次要求用户重试或确认，也不秘密添加服务。粘贴来源链接的 host 不进入列表。归一化后将显式启用列表同步到 URL；无有效网关禁止开始并显示配置错误。
- 每次 raw 请求使用规范化网关基地址附加 `/ipfs/<CID>?format=raw`，并声明 `Accept: application/vnd.ipld.raw`；是否需要其它标准参数由兼容验证确认。只把原始块字节交给 multihash 校验，再按 CID codec 解码；HTML 错误页、200 错误体与哈希不匹配均不可接纳。
- 不携带 cookie/credentials，不发送 referrer；拒绝重定向，防止 HTTPS 降级、绕开启用列表或向未配置来源泄露 CID。网关配置只接受 HTTPS、公网域名（拒绝 localhost、字面 private/link-local IP 与凭据）；纯浏览器无法保证 DNS 不映射私网，需在安全说明中明确残余风险。HTTP loopback 仅允许在不可由生产 URL 启用的测试注入路径。
- 采用 EWMA 延迟与 in-flight 压力综合择优，并先执行并发上限；可从 `ewmaMs * (1 + inFlight)`、初始 800ms、平滑系数 0.25 起步。成功延迟包含读取与验证耗时，不能只是随机轮换。
- 连续失败使该网关冷却：初始 2s，指数退避至 60s，加受控抖动；429/503 合法 Retry-After 生效但封顶 120s。CID 404 只排除当前块此次候选，不因一个缺失 CID 全局熔断；INTEGRITY 立即重罚并至少冷却 60s；用户取消不记故障。每次块读取至多尝试各启用网关一次。
- 保留明确的探索机会（例如每 10 次调度一次）给未测量/冷却到期网关；同一恢复网关仅一个 probe in flight，成功恢复健康。全部冷却时等待最近恢复点，仍受请求期限和取消限制，不忙循环、不无界并发。
- 本地遥测包含成功、失败、在途、EWMA、冷却状态；不对外发送分析，不持久化媒体或 CID 历史。settings 明确告知网关能看到请求 CID、IP 与时间，内容完整性验证不等于保密或安全审核。

### 默认安全上限

| 资源 | 上限/行为 |
| --- | --- |
| 根来源/网关 | 100 / 8 |
| metadata | 1 MiB，深度 16，最多 30000 个解析节点，items 2000 |
| 目录 | 深度 16、检查 10000 个条目、接纳 2000 个候选媒体；触顶返回 partial + LIMIT，不伪装完整 |
| 单 raw block | 4 MiB；实际流计数，不能只信 Content-Length |
| 媒体 | 单资源 64 MiB；预览视频同样先完整验证再使用 Blob，不播放不可信 range 流 |
| 媒体尺寸 | 可识别头信息时最多 40M 像素且单边 <= 16384；超限不解码；无法安全识别的格式显示 unsupported |
| 并发 | Worker 全局 6 个块请求、每网关 2 个；UI 同时 3 个可见资产任务，viewer 优先，不叠加另一套无界池 |
| 缓存/传输 | Worker 已验证块 LRU 16 MiB、资产组装预约合计 64 MiB；主线程 Blob LRU 128 MiB；跨 session 未消费结果的 asset 最多 3 个，每个最多 64 MiB，不形成无界结果队列 |
| 读取总预算 | 每次 discover 最多 128 MiB 已验证输入；每次 asset 最多 96 MiB 块输入（含 DAG 开销）；重复读取计预算，缓存命中也计解析输入 |
| 超时 | 单网关尝试 10s，单块全流程 30s，discover 60s，单媒体 90s，均可提前取消 |
| 进度事件 | 最多每 100ms 一次，终结事件不节流；telemetry 最多每 500ms 一次 |

默认上限集中配置并测试，不通过 URL 提高；触顶显示 LIMIT，不静默丢项。Worker 在组装前预约空间，计入拼接峰值并避免整文件冗余复制，transfer 成功后释放本地预约。client 以跨 session 的未消费 asset 数量限制结果积压；Blob 创建前先清理未引用资源并预约缓存，引用尚存导致空间不足时延后或报 LIMIT。预算分别限制网络块、组装、结果与 Blob，不将其误称为浏览器总内存上限；解码内存另有像素限制与真实浏览器检查。

允许的渲染格式至少包括 JPEG、PNG、GIF、WebP、AVIF 与 MP4/WebM（仍取决于浏览器编解码支持）；媒体 magic/header 识别、预算和浏览器 error 共同控制。HTML、SVG、脚本、可执行内容不作为媒体注入；未知类型不靠 metadata 的 type 强制放行。视频支持 controls、暂停、音量、进度与全屏（浏览器支持时），不自动有声播放。无需实现任意 CID codec 或无限尺寸媒体支持，但所有限制必须可见且可测试。

Blob URL 只由主线程资产缓存创建：替换/淘汰/session 切换/卸载撤销，viewer/下载使用引用计数避免仍在使用时撤销；下载只能下载已验证的媒体字节，文件名清理路径分隔符与控制字符，不触发任意远程导航。原图无 thumbnail 时仍只加载可见项，不把低分辨率展示误称为低成本网络缩略图。

## 用户界面完整行为

- 中文空状态：简洁来源表单，支持目录/多 CID/metadata 切换或统一输入解释，校验与可分享 URL；不以营销落地页取代工具。
- Gallery：标题、描述、来源与数量；暖色编辑式布局、响应式列数、稳定纵横比占位、明确加载/错误/部分结果；没有媒体时与没有来源不同。切换来源立即清空旧集合，新的 loading/error 不显示旧内容。
- 搜索按标题、alt、标签与源路径进行 Unicode 规范化的不区分大小写匹配；类型和多标签过滤只筛选已发现集合，不启动网络全站搜索。显示筛选结果数与清除入口。
- 视口附近预加载，远离视口不解码全部大图；有限并发、可取消重试，缩略图失败可尝试同一项目的可信原图，但仍受预算限制。失败卡片独立重试，不清空成功内容。
- Viewer：打开原图/视频、上一项/下一项、Esc 关闭、左右箭头、图片缩放/复位与触控平移、可见关闭按钮、可信下载。导航集合采用当前过滤结果；直接 `item` 引用被过滤项时仍可打开该项并说明筛选状态。
- Dialog 焦点锁定、打开后正确焦点、关闭返回触发卡片；视频快捷键不覆盖原生控件/输入交互。移动端大触控目标、安全区域、无水平溢出；尊重 reduced-motion，不依赖 hover。
- 设置面板：网关列表编辑、启停、恢复默认、当前网络统计、超时/限制说明；gateway 修改明确重新加载当前来源。进度不伪造百分比，total 未知时用阶段状态。
- 错误分为输入、metadata、unsupported、网络、完整性、超时、限制；用户能区分本地格式问题与远端不可用。离线状态是提示，不把 navigator.onLine 当作可用性证明。
- 无障碍语义、真实 alt、可见焦点、按钮标签、对比度、触控与键盘；状态用 aria-live 合理播报，不逐块刷屏。

## 交付波次与验收证据

### 波次 A：可运行骨架与固定接口

**结果：** 包版本兼容、生产 Worker 技术验证成立、设计输入到位，三个实现域可独立工作。

- 读取外部 API 研究；核验 Node/pnpm 版本与包 engines，查询当前稳定版本，安装在项目内并生成 pnpm-lock.yaml。若当前运行时不支持，不全局升级，报告阻塞。
- 设置严格 TS、Vite Worker 构建、Vitest、Playwright、格式/lint；定义 `dev`、`build`、`preview`、`typecheck`、`lint`、`test`、`test:e2e`、`test:smoke` 脚本。
- 在 `src/shared` 固定上述数据、限额与消息类型，`limits.ts` 导出 `DEFAULT_LIMITS`；实现 ContentReader/exporter 适配、Worker 错误收敛与有界资产生命周期，编译各域消费者验证合约一致。
- 完成可信读取技术验证，拿真实 fixture DAG 通过 Worker 验证单块/多块/目录/HAMT 与取消，不只做 import 成功测试。
- UI 之前读取最终 `DESIGN.md`，先实现有真实状态的基础组件展示面；React 开发工具 react-grab/react-scan/react-doctor 仅用项目级包并按 Vite DEV gating 接入，不运行会改写全局 agent 配置的初始化器，生产不可加载开发工具。

**证据：** 接口可 typecheck；生产 build 含独立 Worker chunk；浏览器得到与 fixture 原始字节完全一致的结果，损坏块被拒绝；generator get 只产出已验证字节，无 Node shim/旁路请求；DESIGN 输入可用。接口或 exporter 适配验证失败时先解决依赖阻塞。

### 波次 B：可信网络与图库解释，可并行

**network 结果：** broker、公平有界调度、CID 验证、缓存、取消、回退、遥测及 ContentReader 适配器。

**core 结果：** URL 解析/序列化、所有 manifest 格式、相对路径、目录发现/递归、媒体识别、partial/error/预算输出。

**证据：** 使用真实有效 CID 与构造 DAG。注入 fetch/时钟验证快网关优先、压力分流、损坏块自动回退、429、404 局部处理、冷却恢复、探索、全部失败、abort 不惩罚；计数证明并发/预算不越界。core 验证 CID/path/ipfs URI/网关链接归一化和特殊字符往返，粘贴 host 不产生网络请求；覆盖三格式等价、extensionless、相对路径、路径逃逸拒绝、HAMT、无扩展名媒体、错误隔离和上限 partial。测试针对行为与接口，不锁定文案或文档文本。

### 波次 C：Worker 生命周期与完整 UI

**结果：** Worker 协议与 UI session controller 集成；主线程不解析 DAG、hash 块或遍历目录；用户可从来源输入完成浏览、筛选、查看、下载与分享。

- UI 可在固定 client 接口上先做开发态 fixture，但生产空状态绝不自动填充 fixture；上线前切换实际 Worker 数据路径。
- 接通 URL/history、可见项调度、Blob LRU/refcount、viewer、错误重试与网关设置。
- 对 React StrictMode 重挂载、快速换来源、取消与重试、Worker error/messageerror 进行生命周期验证。

**证据：** 新来源提交即清空旧集合，loading/错误期间旧卡片不可见；交错结果不恢复旧内容。取消实际停止网络；buffer 可转移而缓存不被 detach。快速换来源和慢主线程下 outstanding asset 与组装预约有界，Blob revoke 与挂起请求最终归零。来源切换、前进返回、直接 item 链接与关闭、分享 URL 均可重现。

### 波次 D：真实表面、性能与交付

**结果：** 生产静态构建在真实浏览器通过确定性端到端验证，公共网络能力单独报告。

- `tests/fixtures` 用标准 UnixFS importer/编码库生成固定媒体、JSON/YAML/TOML、嵌套目录、多块文件、HAMT 目录和损坏响应场景。fixture DAG 的每个块可通过 multihash 独立校验；生成器输出根 CID 与期望内容索引，测试不自己编造 CID。
- `tests/support/trustless-gateway.ts` 作为本地测试专用 raw-block HTTP 服务器，提供 CORS、延迟、超时、404/429、恶意 200/哈希错误；运行两个或多个独立端口以观察调度/回退。生产 app 使用编译期隔离的测试配置注入，不支持 URL 打开 HTTP localhost 后门。
- Playwright 在运行专属空 profile/context 中访问 Vite preview 的生产输出，不能以 page.route 伪造整个 Worker 成功响应。覆盖真实目录、显式/自动三格式 metadata、多个 CID、无扩展名、HAMT、腐坏首网关回退、限制、取消、快切来源、独立卡片重试、下载内容精确匹配、分享/history 与 Blob 清理。
- 375/768/1280px 截图与人工交互检查：空、loading、partial、error、hover/focus、viewer、缩放、视频、settings；至少 Chromium 完整路径，能使用的 WebKit/Firefox补充核心浏览流程。不登录或复用用户浏览器状态。
- 性能在确定性 fixture 上检查主线程响应、可见项网络范围、并发、布局稳定、长任务与重复渲染；通过真实 Playwright Chromium 的 Lighthouse 集成审计空页面和装载图库，移动/桌面各 3 次取中位数，目标各项 100，不运行 lighthouse CLI，不隐藏功能/内容换分。无法完成的指标或工具环境限制如实列为未通过/未验证，不把目标写成结果。
- 用已知有效公共 CID 实测至少一次目录或多块媒体获取，并记录真实 gateway、字节校验、可见渲染和网络失败情况。公共 smoke 独立脚本与报告，不作为离线确定性套件必过项；网络受限不影响 fixture 证据，但必须标明公共检索尚未验证。
- 阅读生产 bundle/network：没有测试数据服务器默认配置、dev tool 运行时代码、原始 HTTP 媒体请求或绕过 broker 的内容请求。README 包含静态部署 base 路径约束、CSP/worker-src/blob 媒体要求、CORS/网关隐私、支持格式/上限、URL 和 manifest 示例、测试运行方式。

建议执行命令（PowerShell，每条独立运行，项目目录）：

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
pnpm test:smoke
```

这些脚本由基础波次创建，命令执行成功不是唯一验收：还须具备上述字节真实性、网关请求记录、DOM 交互、下载内容与清理证据。浏览器/测试服务器/临时 profile 由当前运行创建并在 finally 清理；只清理自己创建的资源，不结束用户进程。

## 完成条件与未消除风险

完成需同时满足：完整来源/metadata 行为、可靠可信数据路径、自适应多网关、边界/取消/清理、中文响应式交互、可分享 URL、生产静态部署、确定性真实浏览器验证和明确公共网络验证状态。编译成功、测试替身成功或截图漂亮都不能单独证明交付。

目前尚待执行证据的事项：最新稳定包/Node 兼容性、exporter 的 generator get 适配与取消传播、公共网关 CORS/raw 支持、实际 HAMT 行为、浏览器媒体 codec 与峰值解码内存。哈希验证不证明媒体安全；预算与浏览器隔离只能降低风险。浏览器 DNS、外部服务限流与离线场景无法由纯前端完全消除。

协调者负责将本计划交给可用的 plan-critic 审查并解决实质阻塞，然后按真实文件边界安排实施；planner 不自行调度流程角色、安装或实现。可调整内部算法细节和执行顺序，但不得弱化验证链、资源上限、最终交互、权限边界或验收范围。修改稳定合约前同步消费者；涉及公共协议、权限、安全保证或范围变化时先升级确认。
