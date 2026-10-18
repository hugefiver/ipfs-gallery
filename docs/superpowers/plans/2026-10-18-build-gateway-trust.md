# 构建期默认网关与配置网关信任策略

## 目标与授权边界

交付可在构建时预置默认 HTTPS 网关、并且只能在构建时选择网关 trustless 策略的应用。未指定策略或指定 `true` 时保持现有严格校验行为；只有显式 `false` 构建可以不比较**实际配置 HTTPS 网关返回块与请求 CID 的内容摘要**。

- 动态发现的 HTTPS provider 和 WSS Bitswap 永远校验 multihash；地址恰好与配置网关相同也不能改变 provider 获取分支的规则。
- 保留 CID 格式、codec、hash 支持与摘要长度约束、块大小、UnixFS 解析、路径、媒体、预算、并发、HTTP 凭据／重定向、取消及清理边界。`verifyBlock` 本身始终是严格校验函数。
- identity CID 仍由 Dedicated Worker 从 CID 本地取字节，不建立桥、不注册或请求 SW、不查询 provider、不访问网关。无来源入口仍不产生内容网络请求。
- 默认网关不是地址锁定：有效配置继续为 URL > 已启用的本地 preferences > 构建默认值。非严格构建信任本次 binding 的有效配置网关，包括既有 URL／preferences 覆盖；信任模式本身不随这些覆盖改变。
- 不新增 UI 控件或模式偏好开关，不改布局、CSS、视觉设计或无关文案。仅按编译模式条件化必要的安全文字，严格构建的现有 accessible names 保持，非严格构建不得声称媒体已经过 CID 哈希验证。不增加软件，不执行 Git 写操作。不修复无关 transport 或 fixture 问题，不覆盖现有未提交实现。
- 本计划仅定义该新增产品能力。现有 SW、网络与依赖 patch 工作由原任务拥有；实施需在其有效接口上增量衔接。

## 构建输入契约

使用 Node 构建进程的两个显式环境变量；不新增运行时配置请求，不把整个环境对象注入客户端，也不引入自动 `.env` 加载约定。

| 输入 | 未设置 | 显式设置 |
| --- | --- | --- |
| `IPFS_GALLERY_GATEWAYS` | 使用仓库内置三个默认候选 | 非空 JSON 字符串数组；按现有 HTTPS 公网网关规则规范化、保持首见顺序去重 |
| `IPFS_GALLERY_TRUSTLESS` | `true` | 只接受精确字符串 `true` 或 `false` |

显式空字符串、空数组、非数组、非字符串元素、超限或不安全 URL 均使构建失败。布尔输入不接受空白、大小写变体、`0`／`1` 等宽松转换。网关数组原始元素数不得超过共享 `maxGateways`（当前为 8），每项原始字符串与规范化结果均不得超过 4096 字符；解析前限制 JSON 文本为 40 KiB。只有缺失值使用内置默认；无效输入不得悄悄回退或只保留有效子集。错误指出变量与条目位置，不回显可能包含凭据的原始值。

构建解析得到只读 `BuildPolicy = { defaultGateways: readonly string[]; trustless: boolean }`。将两个字段序列化为编译常量，例如 `__IPFS_GALLERY_DEFAULT_GATEWAYS__`、`__IPFS_GALLERY_TRUSTLESS__`，通过共享只读模块消费。生产逻辑不接受 `trustless` 参数、setter、全局可写配置或运行时环境探测。测试通过独立的编译配置运行两种模式，不向生产工厂添加模式注入参数。

### 构建与模块接口

1. `vite.config.ts` 在配置解析阶段只解析一次上述输入，再把同一份策略传给应用构建、Dedicated Worker 编译和 `serviceWorkerBundle`。
2. `serviceWorkerBundle` 的独立 `build({ configFile: false })` 必须显式接收并注入该策略，不能依赖外层 Vite 配置继承。开发时的 SW middleware 与生产输出使用相同规则。保留单一自包含 ES module SW、无静态运行时 chunk 依赖及无 `dynamic import` 的检查。
3. `src/shared/gateways.ts` 的 `DEFAULT_GATEWAYS` 成为编译期默认列表的只读出口；内置默认列表与构建解析器需要的数据应放在不依赖编译常量的纯模块，避免配置加载时求值未定义常量。
4. 网关 URL 规范化下沉为 shared 层纯函数，构建解析与运行时代码共用。它只依赖 shared 错误／纯路径工具，不从 shared 反向导入 network，也不加载 provider、Worker 或浏览器全局。现有 `network/gateways.ts`／broker 导出可保留兼容转导出；保留现有 `INVALID_INPUT` 行为。
5. 覆盖相关 TypeScript 编译配置的常量声明；Vitest 默认配置显式提供严格编译值。缺失构建注入是交付错误，不用运行时 `typeof` 回退掩盖。
6. 握手返回只读构建策略身份（布尔值与规范化默认列表），Window、Dedicated Worker、SW 校对本地编译值；这是版本一致性检查，不是策略协商。请求 schema 不接收调用者的模式指令。任一 realm 值不一致必须失败关闭，不能选择较宽松一方，也不能网络降级。

## 数据与信任接口

### 可信结论的产生位置

`src/network/broker.ts` 负责配置网关获取，`src/network/ipfs-source.ts` 负责 provider 优先和配置网关回退。网关是否免摘要比较由编译常量与**执行分支**共同决定，不能根据返回 URL、调用者给出的 `source` 字段、响应头或 hostname 推断。

内部区分两种结论：

- `hash-verified`：完整 CID／字节边界与摘要比较成功，包括 provider、严格网关和 identity。
- `configured-gateway`：非严格构建中，从该 source 实例的规范化配置网关分支完整读取并通过非摘要安全边界的块；不能称作已通过 CID 摘要校验。

保留 `VerifiedBlockSource` 的 `get(cid, signal): Promise<Uint8Array>` 与 `snapshot`／`dispose`／`settled` 形状，reader／exporter 不接收 provenance，不增加信任模式分支，不把自由可写的 `{ trusted: true }` 扩散到核心读取接口。配置网关例外使用仅供网络层与 SW 准入层查询的**source 实例与结果对象绑定的内部证据**：

```ts
// 示意接口：只读查询，不提供可由 caller 调用的 trusted 标记写入器。
configuredGatewayEvidence(source, canonicalCid, exactBytes)
// -> undefined 或 { canonicalCid, gateway, byteLength }
```

- broker 在私有 WeakMap／闭包中记录它实际产生的结果及来源；只有真实网关读取路径能创建免验记录。证据绑定规范 CID、规范网关、source 实例和最终返回的独占字节对象，而不是只绑定 CID。
- `ipfs-source` 的生产构造路径注册自己的 source 身份，只在其私有 fallback 实例产生的证据有效时转承到最终返回对象。provider 分支始终先 `verifyBlock`，不查询免验记录决定是否校验。
- 查询器可以导出；任意标记创建器、可由 caller 填充的 evidence 对象、可替换的 `trusted`／`verified` 属性不能成为权威。未知 source、复制／结构化克隆的标记、其他 source 的结果都不获得免验资格；任意 source 宣称 `verified: true` 也不能跳过 SW 校验。现有自定义测试 source 没有真实资格时仍按严格路径检查。
- 必须在实际返回的字节对象上保存资格，不能在 `slice()` 或缓存复制后凭 CID 恢复信任。生产 source 保证对象独占；不能在准入后再修改或共享给另一个生产者。
- 在该内部接口的契约说明中明确编译期配置网关例外；不因类型名称更改 reader、批量更名或扩展其 API。来源结论在网络层／SW 内闭合，不用名称或 TypeScript 类型断言代替运行时准入。

### 校验与缓存

`parseBlockCid` 的支持集合和长度检查原样保留。可提取严格与非严格路径共用的块边界检查，但它不接受 trust 开关；`verifyBlock` 无条件做完整比较。broker 只在编译非严格且当前为配置网关响应时不调用摘要比较，仍完整执行响应、流读取、大小、取消与清理检查。

缓存采取最小明确策略：

- `VerifiedBlockCache` 继续只保存真正 `hash-verified` 字节。严格构建的现有缓存与 provider 缓存命中行为保留。
- 非严格配置网关结果**不进入持久于该次请求的块 LRU**，broker 和 `ipfs-source` 两处写入都要区分；不新增第二套可信网关缓存。不允许只改 broker 而仍由 `ipfs-source.remember` 将免验结果放入 verified 缓存。
- 同一 binding 的在途同 CID 请求仍可共享完成结果，但 flight 必须携带其真实结论，不能将共享视为验证。独占返回拷贝获得来自实际生产者的资格，而不是依赖 CID 查表重新标记。
- 同 CID 已验证缓存命中仍可直接使用；免验结果不会填充 provider store、Bitswap store 或 verified cache。新的独立请求如未命中 verified cache，仍按 provider 优先后网关回退执行。
- 缓存、flight 和资格均以 source／binding 为生命周期，不跨客户端、session、配置变更、SW epoch 或新构建复用；dispose、controller change、重启保留现有清理语义。弱引用证据不额外保留 payload。
- 缓存命中仍计入 reader 操作输入预算；不提高缓存、响应、assembly、Blob 或在途额度。关闭网关摘要校验不承诺总哈希计算量为零，也不承诺缓存命中率不变。

## 跨 SW／Window／Dedicated Worker 的来源链

三层现有复验分别在 `service-worker/runtime.ts` 的 `start`、`window-source.ts` 的 `get`、`worker/block-bridge.ts` 的桥接 `get`。三者必须同时适配：SW 完成来源限定的最终准入，后续桥只交付这个已准入结果。不能在任意 source 或任意 fetch 响应上用 `if (!trustless) return bytes` 绕过来源检查。

### SW 准入

1. SW 从实际 binding source 获取字节，先检查类型、CID、长度、取消状态，并针对原始返回对象查询 source-bound 资格。在任何异步摘要计算前复制为 SW 独占、定长的字节快照；复制计入既有 working／response 预算，不提高额度。
2. 严格构建始终针对该快照执行 `verifyBlock`。非严格构建只有原对象的上述不可由消息创建的配置网关资格可以免 CID 摘要比较；未知资格和普通 source 结果仍严格校验快照，不能因 CID 相同为复制品重新授予资格。
3. SW 在 flight outcome 中只保存该独占快照、结论与实际规范网关，后续交付仅从快照复制。source 保留或修改原数组不得改变校验或交付字节。不接受 `prepare-block`、`open.config`、fetch header 或其他 RPC 的自报来源。已验证来源不能因任意字符串声明变成配置网关。

### 用现有私有端口交付实际字节

推荐对内部 SW 传输做窄调整：**同源 ticket fetch 继续负责真实 WindowClient 准入，已准入字节改由现有 binding 私有 RPC 返回**。这样不需要新增暗号、签名、hash receipt、独立确认端口或可伪造的 trusted 标记。

1. 保留 `prepare-block`、单次 ticket、真实 `event.clientId` 检查以及 fetch 触发网络读取的规则。fetch 完成后仅返回有界准入状态，不把 HTTP body 当作内容块；即使普通同源服务器模仿状态或响应头，也不能向私有端口交付 SW 结果。
2. Window 在 ticket fetch 成功后发起精确的 `read-block` RPC，字段仅为既有 binding 身份、sequence 与 blockRequestId。SW 要求 consumer 已使用 ticket、实际 flight 已成功准入、尚未交付且没有取消，然后返回绑定身份、规范 CID、长度及独占 `ArrayBuffer`。错误仍由实际 flight 决定，caller 不能附带来源或验证结论。每个 consumer 最多交付一次。
3. SW 从保留的实际 outcome 拷贝一份独占缓冲区并 transfer，不 transfer flight／cache 的共享 buffer。Window 检查私有 RPC 的 pending 请求、session／binding／epoch、CID、长度和编译模式一致性，再原样 transfer 给 Dedicated Worker 的既有私有桥。不从 fetch、外部消息或 caller 提供的 bytes 补齐失败结果。
4. Dedicated Worker 只接收自身建立、由固定生产 Window relay 服务的私有端口上的对应请求结果，严格检查 schema、请求身份、CID、长度与会话存活；公共 Worker 请求不能注入桥接回复。relay 的职责是转交 `WindowBlockSource` 实际结果，不提供 `trusted` 或 `verified` 设值入口。
5. 严格构建保留 Window 与 Dedicated Worker 的 CID 复验。非严格构建在这两个**已闭合私有来源链的桥接边界**不重复 CID 比较：provider 摘要已由 SW 内生产网络路径强制验证，未知 source 已由 SW 复验，唯一例外由真实配置网关资格限定。它们不根据 wire 上的来源枚举决定免验；来源分类保留在 SW outcome 中，不成为 caller 可构造的 ticket。
6. bytes 交付不等于消费或清理完成。`consume`／`discard`／`cancel`、真实 cleanup／settled、超时和 binding close 仍控制释放；增加的 delivered 状态属于现有 consumer，不新增队列。继续按既有 response／working 预算保守计数；transfer 不提前释放槽位，持有缓冲区、待交付结果和控制消息均有既有限额。

请求、返回与端口交接继续使用精确 schema：明确字段集合、规范 CID、ArrayBuffer 类型／长度、request 身份、允许端口个数；reject 多余字段、错配、重放、重复 read、旧 epoch 和模式不一致。同步更新 SW fetch 成功响应、内部 RPC 解析与测试，不保留会绕过准入的新旧双路径。现有内部未提交协议可直接更新；不改 reader 或应用对外 API。

信任根是按预期部署的同源应用代码、浏览器隔离的 MessagePort 与已匹配脚本／scope 的真实 SW。端口只由固定生产入口建立并私有持有，不接受 URL、preferences、普通 caller 或网络响应提供的端口／环境对象。固定的隔离 fixture seam 可以注入依赖，但生产启动不暴露此能力。该边界不声称抵御已执行任意同源脚本或替换应用代码的攻击者，也不因此放宽普通输入或任意 source 的验证。

执行者可采用更小的等价实现，但必须让实际字节通过受保护来源链交付，并证明 provider 无条件校验及未知 source 无法自报免验。不能只确认 SW 曾成功过，再接受与其结果没有绑定的 HTTP body；不能仅凭响应头、裸 metadata 或 caller 指定模式免验。扩大信任根或改变已提交外部协议须交父流程决策。

## 实施波次与完成证据

### 波次一：构建策略成为唯一来源

完成纯构建解析、shared 层规范化、只读编译常量以及三个 realm 的注入；保持 URL／preferences 覆盖。涉及 `vite.config.ts`、shared 网关模块、现有 normalizer 与相关编译配置。

轻量证据：解析器对缺失值、合法规范化／去重、错误数组与布尔值、不安全 URL、大小边界的行为测试；复用并补充 `tests/network/verify.test.ts` 的规范化测试及 `tests/ui/gatewaySelection.test.ts`／preferences 覆盖优先级。测试输入是函数参数或隔离编译值，不冻结本机环境或依赖版本。

### 波次二：分支限定免验与缓存完整性

完成 broker、`ipfs-source` 的 source-bound 资格及 verified-only cache 写入，保持 provider 校验、阶段切换前真实清理、取消、错误优先级和 identity 本地路径。

轻量证据：在独立严格／非严格编译的网络测试中验证：

- 未设／`true`：损坏网关块拒绝且不缓存；正确块可正常验证和命中缓存。
- `false`：配置网关 wrong-hash 字节可返回；动态 HTTPS provider 与 Bitswap wrong-hash 字节拒绝，后续候选／配置网关按既有规则回退。`LIMIT`／`CANCELLED` 不触发更昂贵回退。
- provider 与配置网关地址相同时，provider 获取仍严格，只有后续真正 broker 分支可以免验。
- 同 CID 的免验结果不污染 verified 缓存或 provider store；后续真实 provider 正确结果可缓存；不同 binding 不复用资格，返回数组修改／transfer 不影响缓存。
- 非严格模式仍拒绝不支持 codec／hash、截断 SHA2、超大块、非法响应、路径及媒体输入；identity 与无来源的网络调用数仍为零。

使用现有 `tests/network/broker.test.ts`、`ipfs-source.test.ts`、`verify.test.ts` 和 reader 预算 seam；只补覆盖变动行为所需断言，不批量复制整套 fixture。

### 波次三：私有结果交付与生命周期闭合

完成 SW outcome、ticket fetch 准入与私有 RPC 字节交付、Window／Worker 固定 relay、精确 schema、编译策略握手。依赖前两波次的不可伪造资格和编译常量。维持 `get` 的业务终结与 `settled` 的真实清理分离，不改 reader 的 bytes-only 接口。

轻量证据：扩展 `tests/service-worker/runtime.test.ts`、`bridge.test.ts` 以及受影响的 ownership／settlement 测试，证明非严格网关字节能通过真实三层链；strict 构建不被任何来源声明绕过。false 构建中任意 source 返回损坏 bytes 并附带 `verified: true`／`trusted: true` 也必须失败。证明伪造字段／头、普通同源服务器假响应或替换 body、未消费 ticket 的 read、错 CID／request／binding、跨客户端、旧 boot、重复 read、私有端口关闭及 controller change 都不能生成免验资产。比较私有端口交付的实际字节，不能只断言准入回复成功。

在准入、交付及取消竞态中检查实际槽位和端口释放；同 CID 一个消费者取消不影响其他消费者。保留 lost-ACK、uncertain ownership、清理失败隔离与有界恢复的覆盖。成功回复、业务错误或字节收到都不等同于网络清理完成。

让 source 保留原始返回数组，并在准入成功后、`read-block` 交付前修改原数组；实际交付必须仍等于准入时被校验的独占快照。异步摘要计算也只读取该快照，不读取生产者持有的数组；缓存隔离测试不能替代这条交付保证。

### 波次四：生产产物、安全文案与文档交付

父流程集中承担真实 build／browser 集成；各局部实施者仅运行影响范围内的轻量检查，不各自运行全套。

1. 用任务独占输出目录构建未设／严格及显式 `false` 两类产物，至少覆盖自定义默认列表。行为上证明 main、Dedicated Worker、SW 使用同值；编译策略不一致的产物组合应拒绝连接，不猜测兼容。
2. 在 `/` 与 `/gallery/` 实际加载产物，检查 SW 正确 scope、脚本 MIME、自包含单 bundle、无静态／动态外部 chunk 依赖；不要把“所有应用 JS 只有一个 bundle”加入要求。确认 Dedicated Worker 与应用资源路径及原 CSP 均有效。
3. 使用真实 SW、raw-block、UnixFS 与受限 HTTPS／WSS fixtures：严格产物拒绝损坏网关；非严格产物接受已授权网关 wrong-hash **但结构和媒体有效**的替代字节，并比较实际渲染／下载字节。选择能独立控制的 raw media／manifest fixture，不能以 malformed DAG 解析失败代替摘要策略证据。
4. 两种产物都验证 provider wrong-hash 被拒并走允许的 fallback；WSS 证据不能仅由 HTTP provider 或 stubbed retrieve 替代。缺失的真实链路证据如实保留，不把已有单条 WSS 成功扩写成全套通过。
5. 用真实 URL／preferences 覆盖证明自定义编译默认列表没有变成 allowlist；尝试 URL、storage、RPC、caller 附加字段修改 trustless 不得改变编译策略。保存偏好仍遵守既有严格白名单和默认不写入规则。
6. 两类真实产物都通过 accessible name 操作原始媒体下载并校对下载字节：严格构建保持现有名称；非严格构建使用诚实的原始媒体名称。检查网络设置、信息、加载和下载状态中与该模式有关的完整性承诺，非严格构建不得显示已完成 CID 哈希验证的假承诺。不添加整页文案快照或正则锁；必要名称属于真实可访问操作接口，其他说明由实际表面检查确认。
7. 父流程合并执行必要的 `pnpm typecheck`、`pnpm typecheck:shared`、`pnpm lint`、受影响测试与一次适当的集成测试。既有有效证据仅在相关输入未变时复用；当前失败不能删测、弱化或用重试隐藏。

构建和占用 4183／共享报告目录的浏览器套件串行执行。不得覆盖用户 `dist/` 或占用 4173，不复用个人浏览器 profile，不终止非本任务进程。输出目录、测试服务、端口、profile 与 env 修改由父流程明确拥有，结束后只清理本任务资源；终止进程需 PID 与启动身份。构建命令使用 PowerShell，环境变量仅在该构建子进程中生效或在 `finally` 恢复。计划本身不要求安装工具、真实公共网络测试、重复全量审计或 Git 操作。

README 的最终文档需要说明两个构建变量及错误行为、默认严格模式、覆盖优先级、仅配置网关的非严格信任范围、provider 永远校验、重建／重新部署要求，以及网关可替换整个 manifest／目录／媒体内容的风险。非严格构建不得承诺所有 Blob、原图下载或视频都经 CID 哈希验证；完整组装、媒体检查和私有桥交付不是 CID 完整性证明。保持 HTTP 与 WSS 凭据差异、DNS-rebinding 限制、零来源／identity 行为及无远程媒体 URL 降级的说明准确；数据路径说明对应实际的 ticket fetch 准入与私有 RPC 交付。维护指南中无条件“全部验证后使用”的规则也需限定到严格构建，与授权例外一致。

## 必要安全文字与交付风险

### 按编译模式准确表述安全语义

`src/components/NetworkSettings.tsx` 的网络说明、`GalleryPanels.tsx` 的媒体信息、`ReaderSurface.tsx` 的加载状态与下载 accessible name，以及 `readerDownload.ts` 的通知，均须准确反映同一编译策略。README 的风险说明不能替代运行时界面的准确承诺。

安全文字依据不可变构建常量条件化。严格构建保持准确表述及 accessible names；非严格构建使用“下载原始媒体”和“原始媒体已准备，可下载”等不承诺 CID 完整性的文字，网关说明准确区分配置网关受信任与 provider 始终校验。即使某一项恰好来自已验证 provider，也不为 UI 增加逐资产 provenance 跟踪；非严格构建统一使用不夸大保证的名称。

同时检查相关加载状态和信息标签，不能只修改下载按钮而留下“所有影像均哈希校验”或“已在本地完成哈希校验”。仅修正新模式使其失真的安全语义；不调整布局、CSS、视觉、交互，不新增控件、模式开关或偏好字段，不借此整理无关 UI 文案。README 说明补充运行时文字，不能替代真实界面承诺的修正。

### 集成与安全范围

私有结果交付只调整当前内部桥接边界；如发现需改变已提交公共 API／协议或扩大来源信任范围，停止该项并交父流程确认。安全目标不包含抵御已被控制的应用发布源或任意同源代码执行，但不能因此接受普通配置／消息伪造。

复用既有网络、SW 实现及 fixture 安全边界，真实链路的失败或中断不得记为通过。实施完成的标准是上述行为、来源链、真实产物证据及准确的运行时安全文字全部成立，而不是仅编译成功或日志显示成功。
