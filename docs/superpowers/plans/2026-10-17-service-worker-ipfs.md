# Service Worker IPFS provider 检索

## 目标与完成条件

浏览器通过真实 Service Worker（SW）查询 `https://delegated-ipfs.dev` 的 provider，使用真实 Bitswap/WSS 直接取块，并支持可用 provider 的 HTTPS raw-block 服务；direct 阶段失败才使用当前配置的 HTTPS gateways。SW 负责外部块获取、逐块 multihash 校验及受限同源 IPFS fetch 响应。Dedicated Worker 保留 manifest、UnixFS exporter、发现与媒体装配；主线程保留现有 Blob、Reader、Album、下载及资源所有权。

完成必须包含真实链路证据：应用 → SW fetch handler → 可控 delegated router → 真实 Bitswap/WSS provider → 已验证块 → 既有 UnixFS reader → 与 fixture 相同的显示和下载字节。关闭全部 gateway 内容服务后仍须成功；仅注册 SW、使用消息假回包、以 raw HTTP 代替 Bitswap 均不满足要求。

### 范围与授权

- 不改变 UI 样式、布局、交互、中文可访问名称、URL/query 语义、偏好白名单或下载行为。`SessionConfig` 仍只表达 `gateways` 和 `limits`；provider 策略不增加用户偏好、URL 开关或隐藏运行时配置入口。
- 已授权安装实现及测试需要的 Helia/libp2p 依赖，访问上述 router、直连可达 provider，并在失败后回退当前配置 gateway。仅获取内容，不发布、provide/reprovide、pin、IPNS、DHT、bootstrap、主动 discovery、监听、WebRTC、relay 或应用层 DoH。
- 默认无来源入口不启动 SW 检索节点，不做 router/provider/gateway 连接、预热或健康探测。首次真实读取才懒注册 SW、建立绑定和启动必需连接；静态应用资源请求不属于内容网络请求。
- 不自动执行 Git 写操作，不安装无关工具，不使用个人浏览器 profile，不覆盖用户 `dist/`、占用 4173 或接管已有进程。
- CID、访问 IP 和时序会暴露给实际使用的 router/provider/gateway。HTTP 的无凭据、无 referrer、拒绝重定向要求保持不变。WSS 握手发送本站 Origin，并可能携带 provider 域名已有且符合浏览器策略的 Cookie；用户已接受此残余风险。不能声称已有 HTTP 保证自动覆盖 WSS。

## 结构与现有边界

主要接入点：

| 区域 | 最终职责 |
| --- | --- |
| `src/worker/client.ts` | 保留 `GalleryClient` API；懒启动 SW 绑定，承接 dedicated Worker 的私有块桥接，处理 controller/epoch 变化和窗口 fetch |
| `src/worker/gallery.worker.ts`、`runtime.ts` | 用 SW-backed `VerifiedBlockSource` 替换直接外网 broker wiring；保留会话、取消终态、装配预约和三资产槽 |
| `src/network/types.ts`、`reader.ts`、`verify.ts` | 保留 `get(cid, signal)`、`snapshot()`、`dispose()` 与 exporter 边界；桥接返回后再次校验，缓存命中仍计入 operation input budget |
| `src/network/broker.ts`、`cache.ts` | 现有 gateway 调度/冷却/Retry-After/校验成为 SW 内的显式 fallback；避免再建独立无界或重复块缓存 |
| 新 `src/service-worker/` | SW entry、受限 fetch handler、绑定/生命周期协议、direct broker、provider routing、地址策略及统一资源账本 |
| 新桥接模块，置于 `src/worker/` 或 `src/network/` | Window ↔ dedicated Worker 私有 MessagePort 通道及 SW block-source adapter，不混入公开图库消息 |
| `src/shared/` | SW 内部协议与有界策略常量；复用领域错误、CID 校验和既有资源上限，不引入 UI 依赖 |
| 构建、`tests/`、README/维护说明 | 单文件 SW 输出、子路径部署、真实 TLS/Bitswap 测试服务、SW-aware fixture、最终网络和隐私说明 |

推荐数据路径：

```text
GalleryClient / Window
  ├─ Gallery Worker RPC → discovery / UnixFS exporter / media assembly
  │                         └─ VerifiedBlockSource.get(CID)
  │                              ↓ 私有 MessagePort：块需求/取消
  └─ window fetch(<appBase>__ipfs_gallery__/blocks/<CID>, capability headers)
                               ↓ 实际 FetchEvent，绑定 Window Client.id
     Service Worker：校验路由与所有权 → 有界共享 flight/cache
       ├─ delegated provider routing → Bitswap/WSS 或 provider HTTPS raw block
       └─ direct 失败 → 当前配置 gateway broker
             ↓ 完成块校验后才构造 response
     Window 有界接收并 transfer → dedicated Worker 再校验 → exporter
```

窗口只中继有界块缓冲区，不解析 DAG、不为中间块建 Blob、不缓存第二份内容。选择由 Window 发起 fetch，使 `FetchEvent.clientId` 可直接绑定已握手的窗口；不依赖不同浏览器对 dedicated Worker fetch 的 client 身份实现差异。消息负责控制和中继，内容网络请求真实经过 SW fetch handler，不以纯消息实现替代。

identity CID 保持现有本地校验、零网络语义；内嵌字节不放进巨大同源 URL，不要求经外部检索。所有需要远程取块的 CID 均走上述 SW 数据路径。

## 最小内部协议与安全绑定

公开 `GalleryClient`、`WorkerRequest`/`WorkerResponse` 的现有业务语义保留。桥接使用独立 MessagePort、独立版本和运行时 schema，不能让 UI 消息被解释为 SW 控制指令。内部 runtime 创建 source 时提供 session 身份；无需把 bridge token 写入 `SessionConfig`。

### Window ↔ SW 控制

协议含 `version`、`sessionId`、`bindingId`、SW 实例 `epoch` 和单调增长的控制序号。首个 `open` 由窗口通过 `ServiceWorker.postMessage` 并附 MessagePort 发起，带合法 `SessionConfig`。SW 从实际 `MessageEvent.source` 取得 WindowClient，验证同源、应用 scope、客户端类型和存活状态，不相信消息自报的 clientId。只在绑定的 port 上接受后续控制。

最小操作：

| 操作 | 输入与结果 |
| --- | --- |
| `open` | 校验 config 和窗口身份；返回版本、随机 epoch、bindingId、随机 capability、有效上限；一个 GalleryClient 同时只有一个活动 session |
| `prepare-block` | `{sequence, blockRequestId, canonicalCid}`；准入并预约 consumer/result 资源，返回短期一次性 fetch ticket；不允许重复 ID 启动第二个请求 |
| `cancel-block` | 精确取消本 binding 的 consumer；独立确认控制请求，取消目标只产生一个最终结果；不得取消别的 binding/consumer |
| `consume` / `discard` | 确认指定块响应已转交并被 source 接受，或不再需要；释放响应预约，不转移共享缓存所有权 |
| `snapshot` | 返回当前 binding 的 `GatewayStat[]`；不伪造 provider 为 gateway，不混入其他 tab 的统计 |
| `close` | 撤销本 binding 的票据与资源，终结未完成消费者；不终止其他 tab |

每条控制都有匹配的有界结果/错误。`dispose()` 可同步发起关闭，但底层资源只有实际退出后才回收计数。snapshot 保持同步 API：adapter 缓存经过身份验证的最新快照，由控制事件/遥测刷新，不新增 UI。

### 受限 fetch

- 路径固定为应用 scope 内 `__ipfs_gallery__/blocks/<canonical CIDv1>`；只接受 `GET`、无请求体、无任意 URL/host/path 参数、无重定向、无 Range、无媒体或 HTML 响应。路径需严格一次解析，拒绝额外段、编码绕过和不支持的 CID。
- Header 承载协议版本、binding/epoch、capability、request/ticket 身份；不放在 URL、持久化、日志或对外请求里。Window fetch 使用 `mode: 'same-origin'`、`credentials: 'omit'`、`redirect: 'error'`、`referrerPolicy: 'no-referrer'`、`cache: 'no-store'`。
- 校验 `event.clientId` 等于绑定 WindowClient；客户端仍在 scope，ticket 尚有效且未消费，CID/config 与预约一致。未知/空 clientId、跨 tab 重放、旧 epoch、导航请求、缺失绑定一律 fail closed，绝不回源成为代理。不同路径正常透传静态资源，SW 不缓存/改写页面导航。
- 成功为 `application/vnd.ipld.raw`、精确 Content-Length、no-store、nosniff，并附可验证的协议/epoch/request 标识。只有整块 `verifyBlock` 成功才能产生 body；不流出未验证 network chunks。
- 错误使用有界 JSON 领域错误与明确状态码，例如 INVALID_INPUT/UNSUPPORTED 400、绑定失效 409、LIMIT 429、NETWORK/INTEGRITY 502、TIMEOUT 504、CANCELLED 410。客户端验证错误 schema、长度和对应请求；不可把 SPA fallback HTML 当块或成功终态。
- fetch abort 是辅助信号，不承担完整取消协议。显式控制取消、消费确认、连接丢失处理及过期清理一起防止 SW body/consumer 泄漏。

capability 是同源客户端隔离与误调用防线，不承诺抵抗已经执行在相同 origin 的恶意脚本/XSS。任何 provider 内容、metadata、错误文本都不是配置或指令；保持纯文本，不接受返回内容触发新服务、脚本、IPNS 或 URL 请求。

## Provider 检索与验证

### Direct 和 fallback 的顺序

1. 解析/限制 CID；查本 binding 的已验证块缓存。命中也占响应预算和 reader 输入预算。
2. 在总 block deadline 内进入 direct 阶段，最长 10 秒（同时不超过该请求剩余期限）。从指定 delegated endpoint 仅执行 `GET /routing/v1/providers/{cid}`。
3. 对有界 provider 记录筛选安全地址；优先尝试可用 WSS Bitswap，其次尝试声明 HTTP gateway transport 的 HTTPS provider raw-block 地址。必要的同阶段并发必须经过统一准入并明确可取消；不得让不同库隐式竞争全部 gateway。
4. direct 无 provider、不可达、超时或验证失败后，由显式调度调用当前 config 的 gateway broker，使用剩余 block deadline。每个 gateway 继续保留 EWMA、并发、冷却、Retry-After 和完整性惩罚。
5. direct 成功不得发起 gateway 请求；取消、无效输入、资源准入 LIMIT 不触发更昂贵的阶段。单个 provider 的坏响应可放弃并尝试下一候选；全失败时保留最有意义的领域错误，完整性失败不得被最终普通网络失败掩盖。

块全流程默认仍为 30 秒，发现 60 秒，资产 90 秒。队列等待、provider discovery、拨号、direct、fallback 和返回消费均有独立但不延长外层 operation 的 deadline。切换阶段前结束前阶段工作，避免迟到 direct 与 fallback 叠加占槽。

### Helia/libp2p 组合

- 使用 `createHeliaLight`、显式 `withLibp2pLight` 配置和 `withBitswap`，仅需要的 WebSocket transport、连接加密/muxer 与必要协议服务；不得使用自动包含完整 bootstrap、DHT、discovery 或 DNS 服务的默认配置。
- 生产 transport 使用下述精确版本的仓库维护 pnpm patches；保留标准 Bitswap、Noise、Yamux 与 WSS wire format，不自写替代协议。普通 `BitswapBlockBroker.retrieve` → `Bitswap.want` 是应用选定取块入口；SW 按 binding/CID 合并消费者，不启用另一套 Helia session 检索/缓存路径。测试 provider 仍使用官方库的服务端能力，不把生产的非保存 blockstore 策略施加给 fixture provider。
- Helia blockstore 使用非保存 adapter：不会持久化/累积下载块，不能向远端提供 gallery 内容；正式缓存只由 SW verified cache 持有。不得使用默认无界 MemoryBlockstore。对端在出站连接上仍可能发起 Bitswap want；必须证明没有回应内容字节、provide/reprovide 或后续上传。
- router 使用窄 `findProviders` 适配器，按 Delegated Routing V1 解析有界 JSON/NDJSON，复用官方 CID/peer/multiaddr 类型。其余写入、IPNS、DHT、解析未知 peer 地址的能力不装配或明确拒绝。服务端 filters 只是优化，实际记录与拨号仍须本地校验。
- provider HTTPS 阶段可使用独立 trustless raw-block broker，复用安全 fetch/有界读取/verifyBlock；不引入整文件 `verified-fetch` 或自写 UnixFS/DAG/HAMT。若采用 `withHTTP`，必须 `recursiveGateways: []`，且证明没有重复 router 或隐式 gateway 竞速、无界 body/cache。不能用该选项推断所有 HTTP 请求已受保护。
- 所有 HTTP 路径（router、provider、fallback）均显式 GET、omit credentials、no-referrer、redirect error、no-store，检查实际响应是否 redirected，限制 Content-Length 与实际读取字节，取消超限 reader。provider 记录中的地址不直接透传为任意 fetch URL。
- `withHTTP.transformRequestInit` 只可作为已核实覆盖路径的安全设置；不能推定覆盖 delegated client。缺少可控 fetch/body 上限的依赖不负责该 HTTP 路径，由窄协议 adapter 承担，不通过全局 monkey-patch fetch 绕过。

### 网络地址策略

- 仅允许结构上合法的公共 DNS WSS multiaddr（含等价的 TLS+WS 表达）和 HTTPS provider 地址；peerId 必须匹配记录与实际连接。无需为功能增加 IP literal 支持；公网或私网 IP literal 均可保守拒绝，与现有 gateway 域名策略一致。
- 拒绝 ws/http、localhost、特殊用途域、私网/link-local/loopback 字面地址、userinfo、异常端口、DNSADDR、未知/多层代理组合、relay、WebRTC/WebTransport、任意追加 path/query。合法 HTTPS 服务 path 仅按相应 provider 协议规则解析。
- 地址策略在 provider 解析、peerstore 写入、实际 dial 三处执行；identify 或其他来源学习的地址也不能绕过。不得只相信 router 的 `filter-addrs`。
- 普通 DNS 主机由浏览器解析；禁止应用主动 DoH/TXT lookup，禁用会触发它们的 libp2p resolver。公网域名可能解析到私网，浏览器无法可靠获知解析后的 IP；这是明确残余风险，不声称完成 DNS 防重绑定。
- 不承诺任意 provider 都浏览器可达。CORS、有效 TLS、浏览器 WS 限制和 CSP 都可能造成 direct 不可用；这类失败在同一 SW 内按规则 fallback，不转移到 dedicated Worker 绕过安全边界。

## 生命周期、并发与资源

### SW 注册与首次控制

- SW 输出为应用根目录稳定文件名（例如 `ipfs-service-worker.js`），单自含 bundle，无 dynamic import、运行时 CDN 或跨源脚本。构建正确包含依赖并允许 ServiceWorkerGlobalScope，不能直接依赖开发服务器的模块 graph。
- 保留 `base: './'`；从实际应用入口基址得到脚本 URL、scope 和 fetch 前缀。根部署 scope `/`，子路径部署 `/gallery/`；无需扩大 Service-Worker-Allowed 到站点根，不控制 sibling 应用。
- 注册、active、controller 和协议握手是不同阶段。首次安装可由 `activate` 中 `clients.claim()` 获得当前 scope 客户端；等待 controllerchange/匹配 controller 后才发首次 block fetch。不 reload 页面、不循环等待 `ready`。
- 默认注册/握手期限各 10 秒且计入 operation deadline。浏览器不支持、非 secure context、CSP/注册失败、冲突的非本应用 controller 或协议不兼容均有界返回可重试/UNSUPPORTED 领域错误；不偷偷用旧 dedicated gateway-only 路径。
- 更新默认等待旧客户端释放，不自动全局 skipWaiting。实际发生 controllerchange、SW 重启或 epoch 丢失时，旧绑定立即失效，迟到响应丢弃。正在执行的请求只失败一次；不无界重放 discovery/asset。后续显式重新读取可重新握手恢复；零在途的 idle 绑定可在下一次需求自动重开。
- 版本不兼容或绑定不存在返回明确协议错误；新版本不得误解旧 schema。处理 pagehide、关闭 port、客户端消失和 SW 被系统终止；不依赖 unload 成功、定时器准时或 SW 常驻。

### 隔离和取消

- 同 origin 的不同 tab 共用一个 SW 全局准入账本，但各自绑定 config、session、统计、缓存分区和 consumer。不得共享不同 binding 的 flight 或复用其他 config 的 provider/gateway 结果。
- 同 binding 同 CID 可共享 flight；取消一个 consumer 不取消其他 consumer，最后一个释放才 abort 网络。新 discover 撤销旧 session，但旧工作真实退出前仍计入全局容量。
- 既有业务 cancel：未完成 target 恰好一个 CANCELLED 终态，cancel 请求单独确认；已完成 target 幂等 no-op。progress、snapshot、控制 ACK 都不是 target 成功结果。
- 保留 runtime 的真实运行槽与公开终态分离：发出取消终态不等于释放 active asset/assembly/SW flight。桥接中的实际工作必须结算后才能释放关联资源；失联时按确定的 teardown/实例失效证据结算，不能用 Promise.race 返回就假装网络已结束。
- 内部 source 可提供 `settled(): Promise<void>` 快照屏障，包含调用时已登记但未真正结算的工作，不包含未来请求。业务错误仍有界返回；Dedicated Worker 的运行槽、组装预约和 Window 中继预约只有本地操作退出且屏障确证完成后才释放。清理错误、port 关闭或 ACK 超时不能完成屏障。
- Window 持有跨 Dedicated Worker generation 的旧 binding 清理账本；open 在发送前登记稳定 owner、单调 attempt 序号及随机恢复凭据，随 open 绑定；prepare 在等待回包前登记工作。管理恢复通过新 MessagePort 联系保存的原 ServiceWorker 对象，只允许撤销旧准入及查询 `draining/settled`，校验实际 WindowClient、scope、owner、attempt 与恢复凭据；不依赖可能随 open ACK 丢失的内容 capability，也不授予 fetch 权限。恢复先建立撤销栅栏再排空；异步校验后的 open 在创建 source/准入前再次检查栅栏。稳定 owner 的撤销高水位压缩历史，owner 总数有界，满额 fail closed，不以超时删除 tombstone 后重新接受迟到 open。重复撤销共享同一个 drain；普通“查无记录”不构成结算证明。管理入口有独立有界准入，不创建内容 source，也不受旧 port 的 pending 队列阻塞。
- 无法证明远端清理时，本客户端隔离新 discover/asset 并有界返回错误；cancel/dispose/管理恢复仍可运行，不影响其他 tab。下一次显式读取至多触发一次合并的有界恢复尝试，不后台无限轮询或重放业务。收到原 owner 的真实结算证明才释放旧账。Dedicated crash、controllerchange、新 controller 的空账本或任意新 epoch 都不是旧工作结束证明。
- 如采用 SW 重启恢复证明，boot identity 必须在真实 ServiceWorkerGlobalScope 生命周期内唯一且不变，不能由 runtime factory 重建生成；只接受保存的同一个 ServiceWorker 对象返回新 boot identity，并以该 service-worker record 单执行实例生命周期为前提。不同 registration/controller/scriptURL 相同均不能替代对象身份。该路径须有真实浏览器重启证据；无法获得可靠终止或清理证明时保守保留有界账项。
- final consumer abort、窗口消失和超时终止对应局部工作：HTTP 关闭独占 reader/请求，Bitswap 撤销该 CID 的 want 并拒绝迟到交付。不同 CID 可共享 Bitswap 流；共用流/连接仅在没有其他合法使用者时关闭，连接仍计入独立预算。无法保证取消/停止收敛的库组合不得上线。
- Transport 向 SW 调度者提供可分别观察的结果与清理结算，例如内部 `{ result, settled, cancel() }`：`cancel()` 幂等发起取消，业务 CANCELLED 可先返回，`settled` 只在该操作的发送、查找、拨号、reader 及取消清理确实退出后完成。`settled` 可携带失败，不把 cleanup error 当成功；延迟 cancel flush 期间保留真实 flight/asset 槽，阶段切换等待结算。Bitswap 无 cancel ACK；生产结算证明本地 cancel 已完成实际发送及局部任务退出，不声称远端已确认或保证远端不再发迟到数据。发送失败时保留有界待清理 ownership，不能靠删除 want 或定时器到期伪造完成；A 的取消不得为清理而中止仍服务 B 的共享流/连接。

### 独立预算

既有每客户端跨 session 三资产槽、128 MiB Blob cache、64 MiB assembly reservation、资产大小和 discovery/asset 输入预算保持有效。SW 增加全局预算，不能乘以 tab/session 数而无界增长；新增内部常量不能由 URL 或消息提高。

建议初始硬上限如下，可在实现中通过更保守等价值落实；提高这些上限须重新评估内存与并发证据：

| 对象 | 边界 |
| --- | --- |
| 绑定 | 全局最多 8 个；准入不足返回 LIMIT，不逐出仍在使用的别的 tab |
| block 网络工作 | 全局最多 6 个；每 binding 不超过 config；gateway 并发仍不超过 2/配置上限 |
| 待处理块 consumer | 每 binding 最多 6，全局最多 24；包含排队、在途与等待消费，不建无界队列 |
| 原始单块与消息 | 应用原始块不超过既有 4 MiB/config；编码后的 Bitswap 消息不超过规范 4 MiB，标准互操作单块验收不超过 2 MiB；较大合法应用块由 provider HTTP 或显式 gateway fallback 承担。WS/muxer 缓冲单独有界，不能扩大 Bitswap 消息上限 |
| Yamux 解码 | SW 每连接 Data frame payload 上限 1 MiB，初始接收窗口保持规范 256 KiB，最大接收窗口不超过 1 MiB；未完成帧的解码器保留量不超过 1 MiB + 12 字节。这是传入 decoder 的独立硬边界，不以 stream window 或 Bitswap 消息上限代替；合法多帧消息可以超过单帧上限 |
| 工作缓冲 | 全局最多 64 MiB 显式预约，覆盖接收、校验、复制峰值；库的帧/流/队列另设容量，不能仅检查最终 bytes |
| 已验证块缓存 | SW 全局总计最多 16 MiB，按 binding 分区并受其 config 限制；fallback 不另外保留一套完整缓存 |
| 未消费块 response | 全局最多 6 个/24 MiB；缓存命中同样预约；fetch ticket、body 和消费确认都有期限 |
| 窗口中继 | 每客户端最多 6 个/24 MiB 块预约；读入前预约，转移精确独占 ArrayBuffer，确认接收/丢弃才推进 |
| provider 元数据 | 单次响应最多 256 KiB、单记录最多 16 KiB、最多 16 候选、每候选最多 4 地址、每地址最多 4096 字符；解析中途达到限制即取消剩余 body |
| peer/连接 | 全局最多 32 已接纳 peer、6 活动连接、2 并行拨号；peerstore/datastore/地址和协议元数据均有界，不能以 maxConnections 代替 peerstore 上限 |
| 清理 | 未使用 ticket 5 秒、未消费 body 10 秒；无在途绑定 idle 60 秒回收 cache/peer/节点；全局无工作无连接，不发送保活网络流量 |

长 CID identity 字节仍受 maxBlockBytes 控制，避免无意缩小原有 identity 支持。控制 ID 使用单调序号和有界在途表，不累积永久 tombstone；请求规模用整数/白名单验证，绝不接受无限或负数。每一次分配、cache copy、Response body 与 transfer 必须能对应到预算释放路径；文档不将这些预算描述为浏览器总内存保证。

计时器只辅助回收；每次事件也根据真实期限检查过期。SW 重启后不恢复历史缓存/peer/令牌，不引入 IndexedDB、Cache Storage、localStorage CID 历史或跨 tab 偏好同步。

## 安全前置条件与依赖可行性

这些条件在 provider 集成开始前落实；失败须交回协调者处理，不削减 Bitswap 交付或静默放宽安全要求。

1. **WSS 浏览器限制与授权。** WebSockets Standard 的握手请求固定 `credentials mode: include`、`referrer: no-referrer`、`redirect mode: error`，并绕过 SW fetch 拦截；原生 WebSocket 没有可改为 omit 的参数。浏览器设置 Origin，且可能携带 provider 域名已有并符合浏览器策略的 Cookie，不是将本站 Cookie 发送给任意节点。用户已明确接受此残余风险并授权继续 WSS/Bitswap。不能通过 SW handler 或 fetch wrapper 消除该限制，不得承诺“所有网络均无 Cookie/Origin”；标准的无 referrer/拒绝重定向仍须在目标浏览器验收。
2. **精确依赖与安全补丁。** 保留当前已安装的稳定依赖图；`@helia/bitswap@4.0.20`、`@libp2p/websockets@10.1.14`、`@libp2p/yamux@8.0.3` 使用下述受控补丁。补丁需先通过发布入口行为测试与 frozen install 交付验证，再作为生产集成基础。官方 SW gateway 仅作组合参考，不能由 package range、安装成功或 getWantlist 为空推断取消与资源保证。
3. **不提供内容。** 验证非保存 blockstore 与 Bitswap 的实际行为，包括 peer 在已有出站连接上索取块；不把 `listen: []` 当作禁止上传。若依赖仍会提供下载块或没有安全关闭途径，必须解决或上报，不能把发布禁令改成“仅不广播 provider”。
4. **HTTP 与 DNS。** 窄 routing adapter 和 provider raw fetch 必须足以覆盖请求安全与有界 body；禁用库隐式 DoH。API 不能满足时选择受控适配器或上报，不允许降低 redirect/credentials/body 限额。
5. **协议边界。** 该计划不更改用户公开 query/preferences/Worker 业务协议；新桥接协议属于内部受版本控制的能力。若发现必须改变公开兼容性、数据保证或授权网络范围，交回协调者，不由执行者扩权。

### 受控依赖交付

- 一个 transport/patch owner 维护 `patches/` 中三个精确版本补丁、根 `pnpm-workspace.yaml` 的精确 `patchedDependencies` 映射及对应 `pnpm-lock.yaml`。不卸载、升级或重解析无关稳定依赖；不替换 registry 来源，不修改依赖声明来绕过补丁，不直接编辑共享 pnpm store/node_modules，不依赖 postinstall、运行时 monkey-patch 或仅开发环境的源码 alias。
- 使用现有 pnpm 的 `pnpm patch <包名>@<精确版本>` 提取任务所有的编辑目录，完成最小修改后用 `pnpm patch-commit <编辑目录> --patches-dir patches` 生成补丁和配置；这里的 patch-commit 是 pnpm 生成补丁操作，不是 Git commit。实际更改同时覆盖 `src/*.ts`、包 exports 加载的 `dist/src/*.js`，以及受影响的 `.d.ts`/映射产物；不得只修源码而让生产继续加载旧 dist。保持源码与发布产物的逻辑、类型一致，不为重建这些包另行安装未获准工具。
- 保持未使用补丁失败策略 `allowUnusedPatches: false`，补丁应用失败必须使安装失败；不放宽完整性校验、构建脚本许可或使用 checksum 更新绕过不匹配。锁文件中的包 integrity 和 pnpm patch identity 是供应链交付边界，保留正常管理；不增加整份 lockfile/文档/错误文本的快照锁。
- 在任务所有、没有预存 node_modules 的隔离目录，从实际交付的 manifest、workspace 配置、lockfile、patches 和必要测试输入执行 `pnpm install --frozen-lockfile`，通过包 exports 运行相同功能回归，并构建真实 SW。证明无需手改安装目录、更新 lockfile 或源码 alias 即生效。补丁缺失/不适用的隔离负向安装必须失败；此项验证补丁交付契约，不冻结本机路径、环境或描述性元数据。
- 共享依赖图变更由同一 owner 串行管理。provider 工作者可并行开发 TLS/router/provider，但不能同时 patch/install 或独立改 lockfile；补丁生效后重新启动其测试进程，补跑受影响的服务端供块、取消观测与多 CID 互操作，不把补丁前已加载模块的结果算作补丁证据。无需复制一个无补丁依赖图或修改标准协议来维持 fixture。

### Bitswap：可等待、按 CID 隔离的取消

补丁范围以 `src/want-list.ts`、`src/network.ts`、`src/bitswap.ts` 及其对应 dist 为主；应用不使用的 session 入口不作为取消保证的依据。

- 按 peer、CID 和请求代次记录已发送 want、在途发送、取消及后续 re-want。已发送或在途发送成功的 want 必须发送标准 `cancel: true`；从未发送的取消不拨号、不发送多余 cancel。只有对应 cancel 实际发送完成或该 peer 确认断开后才清掉其待清理状态；不能简单翻转过滤条件后无条件删除所有 cancel。新代次不能被旧代次的发送/删除回调覆盖。
- 同一 CID 的多个调用保留消费者计数/等效 ownership；最后消费者退出才撤销 want。应用级同 binding 合并不能掩盖库的多调用取消语义。不同 CID 的发送队列可共用 peer，但 A 的 AbortSignal 不成为包含 B 的共享发送 job/连接的终止信号。
- debounce 的调度与实际 flush 完成分开：返回可等待的批次结算，串行合并更新，并在成功、失败、stop、peer disconnect 路径结算全部等待者。先装好块/存在性结果监听和 abort 清理再允许发送，避免把 debounce 改成 await flush 后漏掉立即到达的块。禁止无限 debounce 推迟取消。
- `Network.sendMessage` 的 dial、send、drain、close 失败必须向 flush 传播，不能 abort 后吞错并报告发送成功；清理发送使用独立有界期限，不复用已 aborted 的读取 signal，也不能为已取消 CID 重新发现/拨号。已入发送队列但尚未上线的 want 要么移除，要么在发送结算后跟随 cancel；peerConnected 的 full wantlist 与该状态机采用同一代次规则。
- `Bitswap.want` 持有并结算其 `findAndConnect` 任务；成功/失败/取消都停止并等待该操作剩余查找/拨号，不遗留 fire-and-forget 工作。成功收块后对其他已发 want 的清理也受同一规则约束。`stop` 清理 debounce、等待者及队列，不把清 timer 当退出证明。
- cancel flush 失败只在已连接 peer 上有界清理；仍无法发送时保持未结算资源，直到有明确发送成功或连接退出证据，并把该连接置为 draining、停止接纳新使用者。B 仍在使用连接时不得为了 A 强行关闭；B 的既有 deadline/退出使最后使用者释放后再关闭连接并结算 A，不能靠连续加入新工作延长清理。共享连接自身失效可使相关工作失败，但不能伪造 B 成功。不能在 A 未退出时启动其 fallback。

### WebSockets：握手中止与已连接 socket 清理

- 在 `src/index.ts` 的 `_connect` 及对应 dist 中，使 socket 创建后所有握手失败/abort 路径都先进入统一 close/监听清理，再传播原有错误分类；abort 分支不得在 `websocket.close()` 之前 throw。已 aborted 的调用不创建 socket，成功 socket 不提前关闭。
- 覆盖 abort 与 open 同时发生的竞态：不能返回已取消 socket 给 upgrader。连接已交给 upgrader 后按 maConn 的 ownership 清理升级失败。拨号账本保留 socket 到实际 CLOSED/close 或确定实例 teardown；调用 close、错误 promise 返回都不是 socket 已退出的证据。移除临时监听、取消定时器，拒绝晚到 open 重新启用连接。
- `src/websocket-to-conn.ts` 及对应 dist 的 reset 使用浏览器允许的 close 调用，不向原生 `WebSocket.close()` 传递保留状态码 1006；保留本地 abort 错误语义。已建立连接的协议错误、reset 和最终 draining 关闭同样等待真实 socket 退出，不能仅凭库的 aborted 状态或 timeline.close 回收预算。

### Yamux：在读取帧体前限制解码

- 在 `src/config.ts`、`src/muxer.ts`、`src/decode.ts` 及对应 dist/type 中增加库内可选配置，例如 `maxIncomingFrameDataLength`，通过 `yamux(init)` → muxer → Decoder 显式传递。它是本地安全配置，不新增 wire 字段、协议 ID、公共 query 或用户设置。SW 显式设为 1 MiB；未显式设置时按有效最大接收窗口给出有限默认值，保留 fixture provider 的正常配置能力。
- 校验配置为有限安全整数，满足规范初始窗口 256 KiB ≤ 有效 initial window ≤ 有效 max receive window ≤ decoder Data cap；解析默认值后验证，不能只在两个字段同时出现时检查。对端因此可以使用全部获准接收窗口，标准分片大消息无需非标准协商。保留每流的实际剩余 recvWindow 检查及窗口更新，不把 4 MiB Bitswap 消息大小当作 Yamux 帧上限。
- decoder 按需接收至完整 12 字节 header，立即验证 Data 的声明长度，超限时不等待或累积其 body。不得先 append 任意大小整块再检查；逐帧消费合法合并输入，只保留有界未完成 header/body，避免小 subarray 长期持有巨大输入 backing buffer。控制帧的 length 是窗口增量、ping ID 或原因而非 payload 长度，不套用 Data 长度拒绝规则。
- 支持拆分 header/body、同一输入内多帧、零长 Data、FIN/RST 和 WindowUpdate；输入 chunk 总长超过 cap 但由多个合法帧组成时仍能按序处理。恶意帧错误沿 muxer 既有错误通道终止该连接并清空 decoder 保留，连接/流预算随实际退出结算，不继续等待 0xffffffff 字节。
- 解码器界限不等于 WebSocket、Noise、每流读写队列或浏览器总内存界限；这些仍有独立接收/排队预算。该补丁不承诺消除浏览器在 JS 收到 WebSocket message 前的分配。验收衡量声明长度提前拒绝、保留字节上限和真实连接清理，不宣称已在浏览器分配/复现 4 GiB。

参考入口：

- [Delegated Routing V1](https://specs.ipfs.tech/routing/http-routing-v1/)：provider JSON/NDJSON、Peer schema 和 filters。
- [WebSockets Standard §2.2](https://websockets.spec.whatwg.org/#websocket-opening-handshake)：握手 credentials、referrer、redirect 与 service-workers mode。
- [官方 service-worker-gateway](https://github.com/ipfs/service-worker-gateway/tree/v3.5.1)：SW 下 Helia light 组合参考。
- [Helia light/libp2p 实现](https://github.com/ipfs/helia/tree/main/packages/libp2p)、[HTTP 实现](https://github.com/ipfs/helia/tree/main/packages/http)、[Bitswap 配置](https://github.com/ipfs/helia/tree/main/packages/bitswap)：实现前以安装的精确版本为准。
- [pnpm patch](https://pnpm.io/cli/patch)、[patch-commit](https://pnpm.io/cli/patch-commit)、[frozen install](https://pnpm.io/cli/install)：精确补丁映射、应用失败策略及可重装交付。

## 测试与交付分工

### 波次 A：安全可执行的 transport 和 fixture 基础

**结果：** 精确版本补丁经可重装的行为验证后，依赖在真实 SW 中能启动/停止，显式网络策略可实施，并有可控 HTTPS router、真实 libp2p Bitswap/WSS provider 和 fallback gateway。

- Transport/patch 工作者先交付三个最小依赖补丁、发布入口回归和 frozen install 证据，再交付 Helia/libp2p 装配、非保存 blockstore、地址/DNS/HTTP 策略、peer/stream 限额及上述 result/settled 取消接口；不得修改 UI、公开 query/preferences。交接包括具体配置、每个资源的释放条件、候选协议失败与请求准入 LIMIT 的分类，不要求新的公开协议。
- 测试基础工作者可并行负责 `tests/support/` 中 TLS、provider/router/gateway 服务和 fixture 分发；依赖 transport 的协议/安全接口，不假造业务 Worker 返回。现有 `ipfs-provider.ts` 的 `setBlockMode`、`waitForRecord`、want/cancel/实际字节/连接记录是协作入口；补充握手延迟与恶意 Yamux 测试端点只能存在于 fixture。服务端保留标准库收发路径，观测 hook 不得替代解码、发送或伪造 cancel 记录。
- A 的依赖顺序为补丁功能回归 → 隔离 frozen install/真实导出加载 → 真实 SW transport 与 provider 联调。B/C 可围绕稳定 ownership 契约并行，但 transport 安全门未通过前不能把生产链路宣告可用。provider owner 与 patch owner 在同一安装图上做受影响互操作验证；最终集成与重型 suites 由协调者统一执行。
- 本地证据包括 SW 内真实 WSS握手/Bitswap协议协商与标准大小块/多块文件、超限 Bitswap 消息拒绝、HTTP 路径 4 MiB 合法块、停止/取消结算、peer want 不产生内容上传、无 bootstrap/DoH/隐式 gateway。候选传输的协议限制与请求资源准入 LIMIT 区分，前者允许尝试合法 HTTP/fallback 路径。

#### 补丁功能与真实传输验收

- **Bitswap 组件回归：** 从安装包实际导出入口驱动标准 want/cancel 消息；覆盖发送前取消、已发送取消、发送过程中取消、取消后同 CID re-want、同 CID 两消费者与不同 CID 共享 peer、即时块响应、发送失败、stop/disconnect。可控发送屏障未释放时 `settled`/槽位不得提前完成；释放后检查实际编码 cancel、对应代次清理与全部 promise 结算，不以本地 want 数为零代替网络撤销。
- **真实 WSS 多 CID：** SW 同时请求同一 peer 的 A/B，provider 暂停 A 并记录其真实 want；最后消费者取消 A 后观测 provider 解码到 A 的 cancel，B 的实际块成功且哈希/字节正确。A 取消不能导致服务 B 的流/连接被中止；释放 A 的迟到数据不能交付旧请求。所有使用者结束后验证 stream/connection、拨号与 flight 账本收敛，测试 instrumentation errors 必须为空。另测同 CID 一消费者取消、另一消费者成功。
- **握手资源：** 对实际包 `_connect` 使用可控 WebSocket 的组件用例断言 pre-abort 不创建、握手 abort/失败必关闭及清监听、open/abort 竞态不交付失效连接；真实 Chromium SW 对延迟完成握手的 TLS/WSS 服务中止拨号，结合服务端连接关闭与客户端 CLOSED/账本退出确认无残留。替身 close 调用次数只证明分支执行，不取代真实 socket 资源验收。
- **已连接 reset：** 可控 WebSocket 遵守原生 close-code 限制，覆盖连接建立后的 abort/reset，证明不因非法状态码抛错而遗留 socket；真实关闭证据同时覆盖协议拒绝与最终 draining，仍不得为取消 A 提前关闭服务 B 的连接。
- **Yamux 功能边界：** 从完整 header（也包括分片 header）声明 `0xffffffff` 或 cap+1，尚无 body 时即拒绝；持续分片输入不得留下增长的 decoder 缓冲。合法 cap 边界、跨 frame 的 2 MiB 标准块、4 MiB 以内编码消息、合并输入总长超过 cap、多流、窗口补充和控制帧 length 都需正确处理。测可观测保留字节/释放及产出，不做源码字符串锁，不实际申请 4 GiB 来证明拒绝。
- **恶意真实连接：** fixture peer 在真实 WSS/Noise/Yamux 协商后发送超限 Data 声明和有界碎片，并且不因收到 GoAway 而主动关闭，证明客户端共用 decoder 路径立即失败、未验证内容不流出、客户端发起实际关闭并使连接与预算收敛；同时以正常官方 provider 证明分片与流控互操作。攻击发生在协议解码层，不能用 HTTP 超限响应或 Bitswap 超长消息替代。
- **补丁交付：** 隔离 frozen install 后重复上述包入口功能检查与受影响的 fixture 联调/构建，验证生产 bundle 使用修复后的 dist。断言针对消息、取消、资源、协议和交付边界；不锁计划正文、错误措辞、版本清单快照或整份文件 hash。

### 波次 B：SW ownership、fetch 与预算

**结果：** 受限 fetch handler 实际获取并校验块，binding、epoch、config、取消和有界资源都能独立验证。

- SW 工作者负责新 SW entry/protocol/runtime、全局准入和控制/fetch handler；network 工作者负责 direct → fallback 调度并复用 gateway broker 验证与统计。双方共享 ownership/deadline 契约，避免在不同层重复维护独立 flight/cache。
- 单测覆盖 schema、ticket/clientId/epoch、防跨 tab 重放、假 metadata/错误当指令、wrong hash、超大/谎报长度、超时、单消费者和最后消费者取消、并发/peer/cache/未消费响应上限、迟到结果和资源释放。
- 原 gateway broker 的功能测试继续保护 fallback，不保留已失效的 entry wiring 假设。现有 `tests/worker/entry.test.ts` 的 HTTP-date Retry-After 测试迁到真正的 SW fallback wiring，不删掉对应行为保障。

### 波次 C：真实应用接入与构建/部署

**结果：** 普通生产应用的 manifest、目录、图片、视频、缩略图和下载走同一 SW 取块路径，UI 不变，首次控制与恢复有界。

- 桥接工作者负责 `client.ts`、私有 MessagePort、block-source adapter 与 `gallery.worker.ts`/runtime 接入；先完成 B 的协议，保留既有 `GalleryClient` 外观、资源槽和 input budget。
- 构建/部署工作者可在协议稳定后并行负责单自含 SW、相对 base、`/gallery/` scope、稳定脚本更新、MIME/cache header 和 CSP，不能扩大 scope 到其他应用。
- 页面和 SW script 的实际 CSP 都需允许所需 `connect-src 'self' https: wss:`；保留其他安全指令。固定部署可收窄到指定 router/gateway/provider 来源；任意动态 provider 无法使用固定窄名单时，明确 HTTPS/WSS scheme 许可范围而非宣称窄 allowlist。CSP 阻断是有界失败，不以放宽其他指令解决。
- 验证首访无 controller、刷新/导航、浏览器重启 SW、等待更新、强制 controllerchange、多个 tab、旧 session 返回、取消后新请求、BFCache/恢复和无来源零内容网络。浏览器不支持时验证实际错误/重试，不伪造支持。

### 波次 D：正式 SW-aware 验收与说明

**结果：** 确定性与公开网络结果分开、产品输出不含测试注入、现有入口和部署被真实执行。

#### Fixture 安全边界

- `tests/e2e/fixtures.ts` 不再设置 `serviceWorkers: 'block'`。`gateway-route.ts` 的 page/context route 不作为 SW 外网拦截或取消的唯一证据；部署、smoke、audit 共享支持设施也需适配。
- 使用独立 fixture 构建入口，仅在测试构造 SW runtime 时注入精确的本地 TLS router/provider/gateway 和地址策略；生产入口固定生产策略，两者导入相同 runtime、bridge、broker 和 reader。注入不能来自 query、localStorage、用户消息、hostname、端口、webdriver 或生产环境运行时判断。
- 测试允许本地地址只能是 fixture factory 的显式能力，不能放宽生产 normalizer/gater。生产 build 与 fixture build 输出隔离；正式 build 中不得包含 fixture 地址/hostname/测试 SW entry。通过构建图检查与实际运行生产包的拒绝行为证明交付边界，不做描述性文字或环境 snapshot 锁。
- 本地 fixture 使用可信于运行专属浏览器的测试 TLS/WSS；证书和信任例外只存在于专属测试进程，不写系统信任库。测试基础设施提供覆盖 SW/WSS 的 fail-closed 外网隔离，例如本次运行专属的 allowlisted CONNECT/HTTP 测试代理；只允许应用及精确 fixture endpoints，不依赖 page.route 来保证无公网访问。
- 测试路由器只返回明确 fixture providers；WSS provider 使用真实 libp2p/Bitswap 和相同 UnixFS fixture blocks，记录实际连接、协议、请求 CID、响应字节及取消；不能拿 raw HTTP 服务充当 Bitswap provider。

#### 集成验收矩阵

| 要求 | 有用完成证据 |
| --- | --- |
| direct Bitswap | gateway 全禁、HTTP provider 不提供内容；真实 SW fetch 响应、WSS/Bitswap 服务端记录和 UnixFS 显示/下载完整字节一致；至少含多块文件及目录/manifest |
| direct HTTP | router 返回合法 HTTPS provider；有界 raw-block 校验重组成功，配置 gateway 请求数为零；这项与 Bitswap 证据分别报告 |
| 显式 fallback | WSS 候选协议限制允许在 direct 阶段尝试合法 provider HTTP；direct 无 provider/不可达/超时/坏块或候选耗尽后才调用配置 gateway，实际字节正确；未配置域无流量，请求资源准入 LIMIT/CANCELLED 不扩张工作，不能把候选限制误报为请求准入 LIMIT |
| 完整性 | wrong hash、超长帧/块、坏 JSON/NDJSON、伪造 Content-Length、redirect 均拒绝；未验证块不进入 exporter/cache/Blob |
| 取消与资源 | 一消费者取消另一成功；同 peer 两个不同 CID，取消一个撤销其 want/局部工作而另一个成功，全部使用者退出后流/连接收敛；HTTP 最后取消关闭独占请求；阻塞/未消费响应占容量，下一请求得到 LIMIT 或有界等待；迟到成功不更新旧 session、不提前释放槽 |
| 传输清理与解码界限 | 真实握手中止关闭 socket；Yamux 超限声明在完整 body 前拒绝，缓冲与连接回收；合法流控/分片、多 CID cancel 的 provider 日志及实际 B 字节符合上述补丁验收，不能仅以 getWantlist、close 调用或成功日志证明 |
| 可重装补丁 | 精确映射和锁文件在隔离 frozen install 下应用全部补丁，实际导出包/生产 SW 执行行为回归；缺失或不适用补丁安装失败，不靠源码 alias、运行时替换或放宽 integrity |
| 多 tab | 不同 gateways/config 的同 CID 请求、恶意重放 ticket/cancel、一个 tab 关闭/换源均不影响另一个；总 SW 容量不随 tab 无限增加 |
| SW 生命周期 | 首次访问不靠手动刷新；真实终止/重启、更新与失联后请求有界失败且新读取可恢复；旧 epoch 响应拒绝，没有挂起 promise/无限重试 |
| 部署 | `/` 与 `/gallery/` 均实际注册并控制正确路径，sibling 不受控；CSP 下成功执行 SW、Bitswap WSS、Blob 图片/视频和下载；生产 script 无 dynamic-import 运行时失败 |
| 无网络空入口 | 普通无来源入口、仅开关面板/模式时不发内容流量；idle 后无保活/peer连接；不引入 IPNS/DoH/写入/发布 |
| 原有资源契约 | 跨 session 三 asset slots、assembly/unconsumed/Blob 预算、缓存命中计 input、优先级与 LIMIT/CANCELLED fallback 语义、精确下载字节继续有效 |

最终更新 README 的数据路径、浏览器/SW 支持、隐私、direct/fallback 行为、部署/CSP 与测试方法；维护说明同步最终职责。既有 UI 缺陷和审计阈值不属于本次修复，不以跳过测试、retry 或降阈值制造绿色结果。

## 验证协调与完成报告

各工作者只跑与其变更相关的轻量测试/typecheck并返回实际证据和未验证风险；协调者统一运行受影响的重型检查。可复用确实未受变更影响的证据，不把旧网络路径的通过当作 SW 通过。

整合检查使用 PowerShell、隔离 build、专属浏览器和独占 4183；共用端口/报告目录的 suites 串行运行。按最终脚本接入新的 SW/direct fixture suite，并执行：

```powershell
pnpm typecheck
pnpm typecheck:shared
pnpm lint
pnpm test
pnpm build:reader-album
pnpm exec playwright test --config playwright.config.ts --retries=0
pnpm exec playwright test --config playwright.deployment.config.ts --retries=0
pnpm exec playwright test --config playwright.smoke.config.ts --retries=0
pnpm audit:support
```

网络/SW/bundle 改变影响性能证据，因此按现有矩阵运行审计：empty/reader/album × mobile/desktop，每组 3 个样本，真实运行自有 Chromium/CDP，报告 medians、runtimeError 与 numeric LCP；不把 support suite 成功当审计得分。React/组件未改变时不额外制造 UI 重构；交付所需现有 gates 保持。

公开 smoke 使用普通生产构建与真实 router/provider/gateway，单独记录是否确实 direct 成功、是否 fallback、CORS/限流/不可达，不以公共网络偶然成功取代确定性 Bitswap 验收。无 source 的生产运行及实际生产安全拒绝也要检验，不能只测放宽后的 fixture policy。

完成报告说明实现范围、可观测字节/协议/资源结果、各检查实际状态、安全授权/剩余风险和未覆盖的浏览器引擎/屏幕阅读器/真实部署 headers。测试服务、连接、浏览器、临时证书与构建产物仅清理本任务所有的对象；终止进程核对 PID 和启动身份，不按端口/名称清理。
