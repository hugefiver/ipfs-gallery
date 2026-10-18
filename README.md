# IPFS Gallery

纯前端 IPFS 图库，使用 React、TypeScript、MUI 和 Vite，可部署为静态站点。通过 UnixFS 目录、多个 CID 或 JSON/YAML/TOML 描述文件浏览图片与视频，不需要账户、后端或 API 密钥。

应用完全在浏览器运行；先发现并直接连接可用的 IPFS provider，失败后回退到配置的 HTTPS 网关。Provider 的浏览器可达性、路由服务、网关 CORS 和限流都会影响检索。

## 本地运行

需要 Node.js ≥ 22.13.0、pnpm 12.11.0 和项目依赖。在项目目录逐条执行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm preview
```

`dev` 启动开发服务器；`typecheck` 检查类型，`lint` 检查代码，`test` 运行 Vitest。`build` 输出 `dist/`，`preview` 在 `http://127.0.0.1:4173` 预览构建，不是生产服务器。另有 `pnpm typecheck:shared` 检查共享接口。

TypeScript 7 通过 `@typescript/native` 别名提供 `tsc`，TypeScript 6 通过 `typescript` 别名提供 ESLint 等工具使用的 API。两者是工具链兼容配置，`typecheck` 调用 `tsc -b`。

### 构建期网关与验证模式

构建进程接受以下环境变量，不自动读取 `.env` 文件：

| 变量 | 默认行为 | 显式配置 |
| --- | --- | --- |
| `IPFS_GALLERY_GATEWAYS` | 使用内置网关候选 | 非空 JSON 字符串数组；最多 8 个 HTTPS 公网网关，每项最多 4096 字符，JSON 文本最多 40 KiB；规范化后按顺序去重 |
| `IPFS_GALLERY_TRUSTLESS` | `true`，所有来源均校验 CID 哈希 | 仅接受精确的 `true` 或 `false`；`false` 只信任配置 HTTPS 网关，不免除动态 provider 的哈希校验 |

显式空值、不安全地址、无效 JSON、超限输入或其他布尔写法会使构建失败，不会静默采用默认配置。预置网关仍是默认值，URL 网关优先于已启用的本地偏好，最后才使用构建默认值；清除偏好恢复的是该构建的默认列表。

PowerShell 示例（结束后恢复当前终端原来的环境变量）：

```powershell
$previousGateways = $env:IPFS_GALLERY_GATEWAYS
$previousTrustless = $env:IPFS_GALLERY_TRUSTLESS
try {
  $env:IPFS_GALLERY_GATEWAYS = '["https://gateway.example.com","https://another.example.com/ipfs-gateway"]'
  $env:IPFS_GALLERY_TRUSTLESS = 'true'
  pnpm build
} finally {
  $env:IPFS_GALLERY_GATEWAYS = $previousGateways
  $env:IPFS_GALLERY_TRUSTLESS = $previousTrustless
}
```

只有明确愿意信任网关内容时才编译为 `false`。此时，本次来源配置中的网关（包括 URL／本地偏好覆盖）可以替换目录、描述文件及媒体字节，应用不再保证这些字节与请求 CID 对应；页面显示和原图下载也不能视为 CID 完整性证明。动态发现的 HTTPS provider 与 WSS Bitswap 始终验证，即使 provider 主机恰好与配置网关相同。免验网关结果不进入已验证块缓存；块大小、CID 格式、路径、媒体、安全地址和取消等检查仍生效。

两项设置编译进页面、Dedicated Worker 和 Service Worker。修改验证模式需要重新构建并部署完整产物；URL、浏览器存储和运行时消息不能切换模式。不同策略的产物不能混用。开发服务器启动时使用相同输入规则，变更配置后须重启。

## 打开与分享

来源表单和 URL 使用同一解析器，接受裸 CID、`CID/path`、`ipfs://CID/path` 及 HTTP(S) 网关的 `/ipfs/CID/path` 链接。粘贴网关链接只提取内容引用，不采用其主机、凭据、查询或 fragment，也不请求原链接。普通 HTTP 媒体 URL、IPNS 不支持。

| 参数 | 用法 |
| --- | --- |
| `cid` | 可重复，每项一个内容引用；路径含逗号时用此形式 |
| `cids` | 可重复，每项用英文逗号分隔引用；空项报错 |
| `unixfs` | 单个目录或文件引用，自动识别 |
| `meta` | 单个引用，强制按描述文件读取 |
| `browse` | 单值 `1`，跳过目录自动描述文件发现，不覆盖显式 `meta` |
| `q` | 搜索标题、alt、标签和路径，最长 200 字符 |
| `tag` | 可重复，多个标签按 AND 筛选 |
| `type` | `image` 或 `video`，省略为全部 |
| `item` | 媒体稳定 ID，选择阅读器当前项；未知或被筛选排除的 ID 只提示 |
| `gateway` | 可重复的 HTTPS 网关基地址，替换默认列表 |

来源优先级为 `meta` > `unixfs` > 全部 `cid`/`cids`。重复 `meta` 或 `unixfs` 报错；被覆盖的低优先级来源不请求。多来源按参数顺序展开，规范化后去重，最多 100 项。无来源为空状态，无效来源不偷偷改用其他输入。

分享时引用规范化为 `ipfs://<CID>/<逐段编码路径>`。外层查询解码一次，嵌套 URI 路径按段解码一次，不循环解码；裸 `CID/path` 的路径按文字处理。拒绝路径逃逸、反斜杠、NUL、空中间段及解码后产生的分隔符。路径最多 64 段，引用最多 4096 字符。

以下 [IPFS 官方检索教程](https://docs.ipfs.tech/quickstart/retrieve/)的公共样例可复制到应用地址后；公共网关可用性不作保证：

```text
?cid=bafkreie7ohywtosou76tasm7j63yigtzxe7d5zqus4zu3j6oltvgtibeom
?unixfs=bafybeicn7i3soqdgr7dwnrwytgq4zxy7a5jpkizrvhm5mv6bgjd32wm3q4
?unixfs=bafybeicn7i3soqdgr7dwnrwytgq4zxy7a5jpkizrvhm5mv6bgjd32wm3q4/welcome-to-IPFS.jpg
```

第一个引用 `welcome-to-IPFS.jpg`。多文件可写成 `?cid=<引用1>&cid=<引用2>` 或 `?cids=<引用1>,<引用2>`，其中占位内容需替换为真实引用；有效 CID 仍须通过字节完整性与媒体类型检查。

默认是单幅媒体占据视口的阅读器，原始构图完整显示，左上角保留48×48的半透明菜单按钮。普通访问没有来源时侧栏保持闭合，点击“打开来源”进入来源表单；无效输入可打开来源面板并定位错误。图片支持双击／多指缩放、放大平移、未放大滑动切换。普通点击／轻触图片不执行操作。视频保留原生控件和playsInline，不自动播放，不劫持原生键盘／触摸。

通过菜单切换到画册，以最短列瀑布流浏览照片：按实际内容宽度显示 2／3／4／5 列，未知比例先使用稳定占位，不为排版下载所有原图。可见项目优先使用已验证缩略图；选择一项返回对应阅读器，重进画册恢复当前集合的滚动锚点和焦点。模式切换复用同一资产池，不重新读取来源。

工具使用灰白磨砂的左侧覆盖侧栏，默认宽320 CSS px，窄屏收缩，不推挤媒体；网络设置也从当前侧栏进入。主菜单左上角按钮可收起侧栏，子面板左上角箭头返回菜单；右侧关闭按钮或点击侧栏外区域可直接关闭，外侧点击不穿透媒体。菜单提供搜索、标签／类型筛选、排序、来源切换、信息、网关设置与分享；阅读工具提供位置、导航、缩放／复位、复制与验证原图下载。来源与网络草稿跨面板、关闭及模式切换保留，明确取消网络编辑仍放弃草稿。工具开关不重读来源、不重置缩放。下载只由显式点击触发，同项可跨关闭继续，换项／换来源／离开阅读器取消。

阅读区方向键翻页，Enter／M直接打开菜单，Tab可进入持续菜单；Esc关闭当前面板并归还入口焦点，没有面板时回阅读区但不隐藏入口，不回退历史。相册通过空隙轻触／Enter／M切换工具显隐，Tab揭示入口，Esc隐藏工具。输入框、输入法组合和视频原生控制不被抢键。来源提交立即取消旧任务、清空旧媒体并释放引用；前进／后退恢复URL来源状态。

## 浏览器设置

在网络设置中显式开启“保存设置到此浏览器”后，应用只使用 `ipfs-gallery.preferences.v1` 的既有字段保存设置。布局与分设备侧栏字段保留，但不控制沉浸阅读器；阅读／画册模式、浮层可见性和滚动位置只留在本次内存中，不自动写入存储。默认不保存；关闭保存删除此 key 并保留当前内存偏好，“清除已保存设置并恢复默认”同时恢复偏好默认值。不会删除其他应用的存储项，也不会保存 CID、路径、媒体、筛选、历史、认证信息或请求统计。存储不可用、损坏、写入或删除失败会如实提示，内存设置仍可使用。

有效网关优先级为 URL 显式网关 > 本地网关偏好 > 默认网关。打开分享链接、切换模式／浮层或开启保存不会将链接中的网关自动写入本地；只有明确“应用并重新读取”才将编辑器的网关设为本地偏好。清除已保存设置不会覆盖当前 URL 的显式网关。保存仅影响当前浏览器，不做跨标签页同步。

来源与当前选择仍在可分享 URL 中，可能进入浏览器自身的访问历史；它们不会写入应用的偏好存储。不要在公共设备上把 URL 当成秘密。

## 描述文件

三个格式共享 version 1 结构。下面内容等价，使用真实公共文件 CID，仅示范引用格式；媒体能否显示仍取决于字节类型检查和浏览器支持。

**JSON：`gallery.json`**

```json
{
  "version": 1,
  "title": "示例图库",
  "items": [
    {
      "cid": "bafkreie7ohywtosou76tasm7j63yigtzxe7d5zqus4zu3j6oltvgtibeom",
      "title": "公共文件",
      "tags": ["示例"]
    }
  ]
}
```

**YAML：`gallery.yaml`**

```yaml
version: 1
title: 示例图库
items:
  - cid: bafkreie7ohywtosou76tasm7j63yigtzxe7d5zqus4zu3j6oltvgtibeom
    title: 公共文件
    tags: [示例]
```

**TOML：`gallery.toml`**

```toml
version = 1
title = "示例图库"

[[items]]
cid = "bafkreie7ohywtosou76tasm7j63yigtzxe7d5zqus4zu3j6oltvgtibeom"
title = "公共文件"
tags = ["示例"]
```

将文件发布到 IPFS 后，用 `?meta=<目录CID>/gallery.json` 等引用打开；本应用不负责上传。顶层仅允许 `version`、`title`、`description`、`items`。条目允许 `cid`、`path`、`title`、`alt`、`type`、`tags`、`width`、`height`、`thumbnail`，其中 `cid` 与 `path` 至少提供一个。

显式`meta`引用有已知扩展名时只使用对应解析器；无扩展名或未知扩展名时按JSON、TOML、YAML顺序在同一预算内尝试，只有完整通过version 1 schema才接受。

`cid` 必须是裸 CID；有 `cid` 时，`path` 相对该 CID，否则相对描述文件父目录。`./` 与 `../` 可解析但不能越过 CID 根。若描述文件以裸文件 CID 打开，没有可寻址父目录，每个条目及缩略图都必须自带 CID。`thumbnail` 只接受同样规则的 `{ cid?, path? }`，不能使用 HTTP、data 或 javascript 地址。同一内容可有多个编辑条目；稳定ID包含来源、条目序号及内容引用，不是随机值。

标题最多 200 字符，描述 4000，alt 1000；标签最多 20 个，每项 64 字符。`type` 仅为 `image`/`video` 提示，不能覆盖实际类型检查。宽高必须同时提供，均为正整数且不超过 16384。未知字段、未知版本、错误类型、原型污染键和超预算输入均拒绝；YAML 不允许自定义标签或别名展开。文本不解释为 Markdown 或 HTML。

目录按 `gallery.json`、`gallery.yaml`、`gallery.yml`、`gallery.toml` 顺序检查直接子项。第一个存在的文件是唯一权威来源，损坏时报告错误，需显式选择“按目录浏览”（`browse=1`），不会自动跳过。没有描述文件时受限递归扫描，不跟随符号链接，也不解释子目录的描述文件；按输入根顺序、每根路径排序合并，多根失败分别提示并保留成功结果。显式 `meta` 失败不回退为普通媒体。

## 可信读取与限制

数据路径：React → 类型化 Dedicated Worker RPC → 图库服务与 `ipfs-unixfs-exporter` → 受限同源票据请求 → Service Worker → IPFS provider／配置网关。Service Worker 实际取块并按不可变构建策略准入，通过绑定页面与会话的私有通道交付字节；Dedicated Worker 重建 UnixFS 内容，媒体字节转移到主线程生成 Blob URL。默认严格构建在 Service Worker 验证 multihash，并在桥接后再次验证；可信网关构建仅对实际配置网关分支免摘要比较。标准库负责目录、路径与 HAMT，不在主线程解析 DAG。

打开来源后，通过 `https://delegated-ipfs.dev` 查询 provider，尝试浏览器可连接的 WSS Bitswap 或 HTTPS provider；直接获取失败后才使用配置网关。网关 broker 依据 EWMA 延迟和在途压力分配请求，失败进入冷却并探测恢复。直连不保证每个 CID 都有可达 provider，回退成功也不等于 P2P 成功。应用不启动 bootstrap、DHT、DoH、IPNS、relay 或监听服务，不发布或向其他节点提供内容，不需要本机后台 IPFS 节点。失败不得降级到未验证的远程图片、网关预览页或普通文件响应。

没有来源时不发起内容网络请求；identity CID 从其自身携带的字节解析。Service Worker 的配置、取消和一次性块请求按页面客户端与会话隔离。通信失联时请求会报告错误，但只有确认旧网络工作清理完成或原执行实例已结束，才释放其资源额度；无法确认时暂停该页面客户端的新内容工作，后续显式读取尝试恢复，不影响其他页面客户端。不会悄悄绕回 Dedicated Worker 直接联网。验证缓存只在内存中，不提供离线持久缓存或后台常驻连接保证。

未预置构建网关时，默认候选为 `https://ipfs.4everland.io`、`https://gateway.pinata.cloud` 和 `https://trustless-gateway.link`，可在网关设置中替换。这不是健康保证；请求可能在这些已启用的服务之间自动回退。

| 资源 | 默认上限 |
| --- | --- |
| 根来源 / 网关 | 100 / 8 |
| 描述文件 | 1 MiB，深度 16，30000 节点，2000 条目 |
| 目录扫描 | 深度 16，10000 个条目，2000 个媒体候选 |
| 单块 / 单媒体 | 4 MiB / 64 MiB |
| 媒体尺寸 | 4000 万像素，单边 16384 |
| 并发 | 全局 6 个块，每网关 2 个，资产 3 个 |
| 缓存 / 组装 | 块 LRU 16 MiB，Blob LRU 128 MiB，组装预约合计 64 MiB |
| 操作输入 | 每次发现 128 MiB；每次资产 96 MiB，缓存命中也计入 |
| 超时 | 网关尝试 10 秒，块全流程 30 秒，发现 60 秒，媒体 90 秒 |

资产与解析限制集中在 `src/shared/limits.ts`，Service Worker 另有跨客户端的网络与响应预算，URL 不能提高上限。目录触顶返回部分结果和 LIMIT 提示，不伪装完整。大小已知的媒体最多 64 MiB；大小未知时需同时预算分块与最终连续缓冲区，默认最多 32 MiB。未消费资产结果跨 session 最多 3 个；组装、结果积压、缓存和输入各自有界，这不是浏览器总内存上限，解码仍可能占用更多内存。Blob 引用在淘汰、换源和卸载时释放，仍被查看器或下载引用的资源不会提前撤销。

Bitswap 编码消息最多 4 MiB，标准单块互操作范围为 2 MiB；应用允许的更大合法块通过 HTTP provider 或网关获取，不因此降低 4 MiB 的原始块上限。连接、peer 状态、传输缓冲与待消费响应另有独立限额；一个 CID 取消不会关闭仍在服务其他 CID 的共享连接。

图片支持 JPEG、PNG、GIF、WebP、AVIF，视频支持 MP4/WebM，仍受浏览器编解码支持限制。魔数和头信息检查拒绝 HTML、SVG、脚本及未知类型。视频也必须先完整获取并通过对应构建策略与媒体检查，单文件最多 64 MiB，不直接播放远程 range 流。CID 哈希验证只证明字节完整性，不证明媒体无恶意或适合观看；可信网关构建不对免验网关字节提供这一完整性保证。

**视频尺寸限制的已知风险：** 当前 MP4/WebM 尺寸检查依赖容器声明，不能保证实际码流解码尺寸受上述像素与单边上限约束。WebM 已确认可在声明小尺寸的同时解码为更大帧；MP4 同类风险尚未完成验证。视频兼容范围保持不变，不应将容器尺寸检查视为恶意媒体的解码内存安全保证。

## 网络隐私与部署

路由服务、所连接的 provider 和回退网关可能看到访问者 IP、请求 CID 和时间。内容检索的 HTTP 请求不带 cookie/credentials、不发送 referrer、拒绝重定向。**原生 WSS 握手不同：浏览器会发送本站 Origin，并可能携带目标 provider 域已有且符合浏览器策略的 Cookie；应用无法把 WebSocket 握手设置成 `credentials: 'omit'`。这不表示会把本站 Cookie 发送给任意 provider。** 统计只留在本地，不外发分析、不持久化媒体或 CID 历史。

HTTP provider／网关需允许浏览器 CORS 并支持 raw-block 响应。配置网关只接受 HTTPS 公网域名，可带路径前缀，但不能带凭据、查询或 fragment；provider 地址也经过协议与公网目标校验，拒绝本地、私网和不安全地址。浏览器无法保证公网域名的 DNS 不映射到私网，这仍是残余风险；这些检查不是完整的 DNS-rebinding 防护。

`pnpm build` 后将完整 `dist/`（含 Service Worker 脚本）放到 HTTPS 静态站点，本地开发可用 localhost 安全上下文。Vite 使用 `base: './'`，支持域名根目录或固定子目录；子目录入口应带尾部 `/`，Service Worker 必须与应用同源并覆盖应用目录。不要把 Worker 脚本请求重写成 HTML。可分享的来源、选择与筛选使用 URL 查询，阅读／画册模式和浮层状态只留在内存中；不使用路径路由，不需要服务端 SPA 路由重写。不要用 `file://` 代替 HTTP(S) 部署。

CSP 至少要允许同源脚本、Worker、同源块请求、Blob 图片/视频，以及路由服务、provider 和配置网关的 HTTPS/WSS 连接。Service Worker 脚本响应的 CSP 也须允许对应连接。以下仅是起点：`https:` 和 `wss:` 允许任意相应协议主机；收窄主机列表会限制动态 provider 直连，不能宣称任意 provider 仍然可达：

```text
default-src 'self'; script-src 'self'; worker-src 'self' blob:; connect-src 'self' https: wss:; img-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'
```

生产构建将入口的全局 CSS 内联到 HTML，使启动界面不必等待额外样式请求；CSS 资源仍保留在构建目录。MUI/Emotion 也会注入样式，组件可能使用内联样式，因此示例含 `style-src 'unsafe-inline'`，不能称为严格 CSP。需要更严格策略时，须为构建内联样式配置 hash 或 nonce，并适配 Emotion nonce、响应头及组件内联样式用法，再实测生产页面；仅从响应头删掉 `unsafe-inline` 可能破坏布局。开发服务器的连接需求另行配置。

## 验证

除类型、lint、单元测试和构建外，按环境执行：

```powershell
pnpm build:reader-album
pnpm test:e2e
pnpm test:smoke
pnpm test:deployment
pnpm audit:browser
pnpm audit:support
pnpm doctor:react
```

`pnpm test` 固定使用严格编译策略；非严格策略回归使用 `pnpm exec vitest run --config vitest.gateway-trust.config.ts`，不会通过当前 shell 环境切换普通单测的验证模式。

双模式浏览器验收使用 `pnpm exec playwright test --config playwright.build-policy.config.ts --retries=0`。先以相同的自定义默认网关列表，将严格与非严格产物编译到两个独立目录；测试环境变量 `SW_GALLERY_STRICT_BUILD_DIR`、`SW_GALLERY_FALSE_BUILD_DIR` 分别指向这两个目录，`SW_GALLERY_EXPECT_DEFAULTS` 为编译进两份产物的规范化网关 JSON 数组。这些变量仅选择测试产物和预期值，不是产品运行时开关；该套件覆盖真实字节、网关免验边界及混合策略产物的拒绝行为。

`test:e2e` 面向确定性浏览器用例：标准 UnixFS 工具生成真实 fixture DAG，专用代理将明确列出的路由、WSS provider 和 HTTPS 网关地址映射至本次创建的本地服务，其余内容网络请求全部拒绝。请求经过真实 Service Worker、Dedicated Worker、校验、重建与 UI，不伪造 Worker 成功结果。直连用例阻断网关并比对实际媒体字节；HTTP provider 与网关回退另行验证，不能代替 Bitswap/WSS 证据。测试使用专属空浏览器 profile/context 和限定的夹具证书信任，不复用个人浏览器状态或放宽生产地址策略。

验证使用 `.reader-album-build/` 和 `http://127.0.0.1:4183`，不覆盖 `dist/` 或占用常规预览的 4173 端口。手动预览隔离构建可运行 `pnpm preview:reader-album`；测试前关闭这个独立预览，让测试启动自己的服务。

`test:deployment` 在 `/gallery/` 子目录提供隔离构建产物，验证上面的 CSP 示例、Service Worker 的脚本与 scope、同源模块 Worker、资源路径与可操作的网络错误界面；先运行 `pnpm build:reader-album`。它不替代部署平台真实响应头的验收。

`test:smoke` 单独检验公共 CID 与真实网络，受 provider 可达性、CORS、限流及网络状态影响，不等同于离线确定性测试；报告应区分 direct 与网关回退，不能仅凭渲染成功宣称 P2P 成功。`audit:browser` 通过专属 Playwright Chromium 的 CDP 端点集成 Lighthouse 检查页面；`audit:support` 运行审计支持设施测试（`playwright test --config tests/audit/support.config.ts`），不代表应用审计分数。`doctor:react` 运行 React Doctor。审计和测试报告写入忽略的运行产物目录；审计目标不等于已取得的分数。发布前须按实际部署响应头再次验证 CSP 与内容检索。

浏览器截图与字节／网络证据位于 `test-results/e2e/`、`test-results/smoke/`，交互测试的 HTML 报告位于 `playwright-report/e2e/`；Lighthouse 的三次采样、汇总 JSON 与页面图像位于 `test-results/audit/`。共享预览端口的套件应串行执行，每次运行会替换该套件的旧产物。真实屏幕阅读器、其它浏览器引擎和部署平台的网络环境仍需分别实测。
