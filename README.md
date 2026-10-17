# IPFS Gallery

纯前端 IPFS 图库，使用 React、TypeScript、MUI 和 Vite，可部署为静态站点。通过 UnixFS 目录、多个 CID 或 JSON/YAML/TOML 描述文件浏览图片与视频，不需要账户、后端或 API 密钥。

应用完全在浏览器运行；公共网关的可用性、CORS 和限流会影响检索。

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

数据路径：React → 类型化 Worker RPC → 图库服务 → `ipfs-unixfs-exporter` → 自适应 CID raw-block broker → 已配置 HTTPS 网关。每个块先完成 multihash 校验，再交给 exporter 重建 UnixFS 内容，媒体字节转移到主线程生成 Blob URL。标准库负责目录、路径与 HAMT，不在主线程解析 DAG。

broker 依据 EWMA 延迟和在途压力分配请求，受并发上限约束；失败进入冷却，自动回退，并探测恢复的网关。只使用已披露的启用列表，不直接连接 Bitswap，不需要后台 IPFS 节点，也不需要 Rust/WASM。失败不得降级到未验证的远程图片、网关预览页或普通文件响应。

默认候选为 `https://ipfs.4everland.io`、`https://gateway.pinata.cloud` 和 `https://trustless-gateway.link`，可在网关设置中替换。这不是健康保证；请求可能在这些已启用的服务之间自动回退。

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

限制集中在 `src/shared/limits.ts`，URL 不能提高上限。目录触顶返回部分结果和 LIMIT 提示，不伪装完整。大小已知的媒体最多 64 MiB；大小未知时需同时预算分块与最终连续缓冲区，默认最多 32 MiB。未消费资产结果跨 session 最多 3 个；组装、结果积压、缓存和输入各自有界，这不是浏览器总内存上限，解码仍可能占用更多内存。Blob 引用在淘汰、换源和卸载时释放，仍被查看器或下载引用的资源不会提前撤销。

图片支持 JPEG、PNG、GIF、WebP、AVIF，视频支持 MP4/WebM，仍受浏览器编解码支持限制。魔数和头信息检查拒绝 HTML、SVG、脚本及未知类型。视频也必须先完整验证，单文件最多 64 MiB，不播放未验证的 range 流。CID 哈希只证明字节完整性，不证明媒体无恶意或适合观看。

**视频尺寸限制的已知风险：** 当前 MP4/WebM 尺寸检查依赖容器声明，不能保证实际码流解码尺寸受上述像素与单边上限约束。WebM 已确认可在声明小尺寸的同时解码为更大帧；MP4 同类风险尚未完成验证。视频兼容范围保持不变，不应将容器尺寸检查视为恶意媒体的解码内存安全保证。

## 网关隐私与部署

网关会看到访问者 IP、请求 CID 和时间。请求不带 cookie/credentials，不发送 referrer，拒绝重定向；统计只留在本地，不外发分析、不持久化媒体或 CID 历史。网关需允许浏览器 CORS 并支持 raw-block 响应。配置只接受 HTTPS 公网域名，可带路径前缀，但不能带凭据、查询或 fragment；拒绝 localhost 和字面私网/link-local IP。浏览器无法保证公网域名的 DNS 不映射到私网，这仍是残余风险。

`pnpm build` 后将 `dist/` 放到 HTTPS 静态站点。Vite 使用 `base: './'`，支持域名根目录或固定子目录；子目录入口应带尾部 `/`。可分享的来源、选择与筛选使用 URL 查询，阅读／画册模式和浮层状态只留在内存中；不使用路径路由，不需要服务端 SPA 路由重写。不要用 `file://` 代替 HTTP(S) 部署。

CSP 至少要允许同源脚本、Worker、Blob 图片/视频，以及配置网关的 HTTPS 连接。例如以下仅是起点，`connect-src https:` 会允许任意 HTTPS 主机，固定网关部署宜收窄到实际来源：

```text
default-src 'self'; script-src 'self'; worker-src 'self' blob:; connect-src 'self' https:; img-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'
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

`test:e2e` 面向确定性浏览器用例：标准 UnixFS 工具生成真实 fixture DAG，隔离浏览器将测试 HTTPS 网关请求路由至本地块服务，走真实 Worker、校验、重建与 UI，不伪造 Worker 成功结果。测试使用专属空浏览器 profile/context，不复用个人浏览器状态，生产应用仍只允许 HTTPS 公网网关。

验证使用 `.reader-album-build/` 和 `http://127.0.0.1:4183`，不覆盖 `dist/` 或占用常规预览的 4173 端口。手动预览隔离构建可运行 `pnpm preview:reader-album`；测试前关闭这个独立预览，让测试启动自己的服务。

`test:deployment` 在 `/gallery/` 子目录提供隔离构建产物，验证上面的 CSP 示例、同源模块 Worker、资源路径与可操作的网络错误界面；先运行 `pnpm build:reader-album`。它不替代部署平台真实响应头的验收。

`test:smoke` 单独检验公共 CID 与真实网关，受 CORS、限流及网络状态影响，不等同于离线确定性测试。`audit:browser` 通过专属 Playwright Chromium 的 CDP 端点集成 Lighthouse 检查页面；`audit:support` 运行审计支持设施测试（`playwright test --config tests/audit/support.config.ts`），不代表应用审计分数。`doctor:react` 运行 React Doctor。审计和测试报告写入忽略的运行产物目录；审计目标不等于已取得的分数。发布前须按实际部署响应头再次验证 CSP 与网关访问。

浏览器截图与字节／网络证据位于 `test-results/e2e/`、`test-results/smoke/`，交互测试的 HTML 报告位于 `playwright-report/e2e/`；Lighthouse 的三次采样、汇总 JSON 与页面图像位于 `test-results/audit/`。共享预览端口的套件应串行执行，每次运行会替换该套件的旧产物。真实屏幕阅读器、其它浏览器引擎和部署平台的网络环境仍需分别实测。
