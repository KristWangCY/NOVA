# NOVA v0.12 协议摘要

本文记录当前实现的持久化和签名边界。代码是最终权威来源；任何不兼容修改必须先增加协议版本和测试向量。

## 基本参数

- 哈希：SHA-256，小写十六进制。
- 签名：Ed25519；公钥为 DER SPKI 的 Base64，私钥为 DER PKCS8 的 Base64。
- 地址：`nova1` 加公钥 DER 字节 SHA-256 的前 40 个十六进制字符。
- 编码：对象 key 按 Unicode 码点顺序排序的 canonical JSON，无空白。
- 金额：十进制非负整数字符串；不允许浮点数。
- 资产：`1 NOVA = 1,000,000 unova`。

## 账户 keystore

普通账户私钥以及私人网络的验证者、水龙头私钥默认保存在版本化 `nova-keystore` 中。当前格式使用 scrypt（`N=32768, r=8, p=1`）派生 256 位密钥，并用 AES-256-GCM 加密完整 Ed25519 key record。地址、公钥、标签和格式版本作为认证附加数据，因此修改公开元数据也会导致解密失败。密码不写入文件；节点配置只记录用于解锁的环境变量名称。

## 交易公共规则

当前支持 `transfer` 和 `record` 两种 version 1 交易。两者共同提交 `version`、`chainId`、`type`、`from`、`fee`、`nonce` 与 `publicKey`，由 `from` 的 Ed25519 私钥签名。交易 ID 是类型专属签名载荷连同 `signature` 的 canonical JSON 哈希。任何缺失字段或额外未签名字段都会被拒绝，避免同一交易 ID 携带不同旁路数据。

两种交易共享同一账户 nonce 空间，nonce 必须严格等于发送者已提交 nonce 加一。手续费从发送者余额扣除并从总供应量销毁。

## 转账

`transfer` 的专属字段是 `to`、`amount` 和 `memo`；完整签名载荷保持与 v0.1-v0.5 相同。

有效转账必须满足：

- chain ID 与当前链相同。
- 公钥派生地址等于发送者。
- Ed25519 签名有效。
- nonce 严格等于发送者已提交 nonce 加一。
- 发送者余额不少于金额与手续费之和。
- memo 不超过 256 UTF-8 字节。

转账金额记入接收者，手续费从总供应量中销毁。

## 文件与个人记录存证

`record` 的完整签名载荷由公共字段和以下专属字段组成：

- `hashAlgorithm`：当前必须是 `sha256`。
- `contentHash`：文件原始字节的 64 位小写 SHA-256。
- `contentSize`：文件字节数，非负安全整数。
- `title`：1 至 128 UTF-8 字节。
- `category`：1 至 32 位小写字母、数字、`_` 或 `-` 组成的 slug。
- `note`：最多 256 UTF-8 字节的公开备注。

record 手续费必须为正数，防止零余额账户无限写入。执行时只扣手续费、推进账户 nonce 和累计销毁量，不把记录复制进状态对象；权威记录保留在签名区块中。因此创世状态格式和历史 transfer 状态根不变，v0.6 实现已成功重放现有高度 221 的 v0.1-v0.5 链。

文件内容、文件名和本地路径不属于交易。提交区块时间表示共识确认时间；record 不接受用户自行声明的可信时间。相同内容可以被多个账户或同一账户重复记录。

## 区块

区块头提交前一区块哈希、时间 slot、提议者、交易 Merkle 根和交易执行后的状态根。区块哈希是 canonical 区块头的 SHA-256。提议者必须是 `validators[slot % validatorCount]`，并签署区块哈希。

验证者对 `{chainId, height, slot, blockHash}` 签名。当前提交阈值是 `ceil(2N/3)`；默认三验证者网络需要两个签名。

正常提议采用 peer-first 顺序。轮值提议者先把已签 proposer hash、但尚未附加自己 commit vote 的 proposal 发给全部 peers；每个返回 vote 都必须按创世公钥验证并去重。只有已取得至少 `quorum - 1` 个非本节点有效 vote 后，提议者才为同一 proposal 写入自己的持久化投票锁并签名，然后再次完整验证 quorum、提交并广播区块。单验证者开发 fixture 的 quorum 为 1，不需要 peer vote。HTTP 成功、伪造签名、重复 validator 或错误 proposal 的 vote 均不计数，因此孤立验证者不会仅因一次本地出块尝试锁住自己。

如果 peer 已经持久化 vote、但响应或原提议者在提交前丢失，该 peer 会周期性发送 version 1 锁恢复请求：

```json
{
  "version": 1,
  "proposal": { "header": {}, "transactions": [], "hash": "...", "proposerSignature": "..." },
  "proofVote": { "validator": "nova1...", "signature": "..." }
}
```

`POST /proposals/recover` 仍使用 `ed25519-v1` 精确请求认证；`proofVote.validator` 必须等于认证发送者，并且确实签署该 proposal。尚未在该高度投票的接收节点可对当前或历史 slot 的有效锁提议投票，但拒绝超过本机当前 slot + 1 的未来提议；已锁节点只会重发相同 hash 的 vote。收集到 quorum 后，任意持锁验证者都可组装、验证并广播 committed block。

该恢复能处理常见的错峰启动、投票响应丢失，以及两个验证者锁在不同 proposal 而第三个尚未锁定的情况。它不是多轮 BFT view-change：如果所有验证者已锁在互不相同的 proposal，或 Byzantine 验证者故意双签，当前原型仍可能停顿或产生 ADR 0001 所述风险，必须人工隔离或迁移成熟共识。

节点在 mempool 有交易时会在下一个合法提议 slot 尝试出块。网络空闲时默认最多每 30 秒产生一个心跳空块，避免个人链因高频空块无意义增加存储、备份和同步成本；该间隔属于节点配置，不改变交易执行规则。

## 状态

状态由高度、余额表、nonce 表、当前总供应量和累计销毁手续费组成。节点从相同创世状态按区块交易顺序执行，必须得到与区块头相同的状态根。

## 验证者请求认证

验证者之间的写入型请求使用 `ed25519-v1` 认证。发送者用自己的创世验证者私钥签署以下 canonical JSON：

```json
{
  "domain": "nova-peer-request",
  "version": 1,
  "chainId": "nova-local-1",
  "validator": "nova1...",
  "recipient": "nova1...",
  "method": "POST",
  "target": "/blocks",
  "bodyHash": "原始 HTTP 请求体字节的 SHA-256",
  "timestamp": 0,
  "requestId": "UUID"
}
```

签名通过 `x-nova-peer-version`、`x-nova-peer`、`x-nova-peer-timestamp`、`x-nova-peer-request-id` 和 `x-nova-peer-signature` 请求头传递。接收者必须确认发送地址属于当前创世验证者集合、签名指定的接收者是自己、签名匹配、时间戳距离本机不超过 30 秒，并在内存中拒绝同一验证者重复使用 request ID。只有签名验证成功的请求才进入有界重放缓存。

认证强制用于 `POST /proposals`、`POST /proposals/recover`、`POST /blocks` 和带 `gossip=0` 的内部交易传播。普通 `POST /transactions` 仍允许 CLI 提交，因为交易本身具有账户签名；`GET /blocks` 同步仍是只读接口，收到的区块必须逐块通过提交签名和状态重放验证。

该协议提供验证者身份、请求完整性和短时重放保护，不加密流量，不隐藏交易或区块，也不提供限流。重放缓存随节点重启清空，但三类内部操作本身具有重复安全检查。迁移到多主机前仍必须使用可靠时钟同步，并在私网覆盖或 mTLS 中承载 HTTP。

## 签名节点状态

远程运维不信任裸 `GET /status`。操作者为每次查询生成新的 UUID challenge，请求 `GET /status/signed?challenge=<UUID>`。节点返回 version 1 精确字段响应：

```json
{
  "version": 1,
  "challenge": "UUID",
  "timestamp": 0,
  "status": {
    "name": "node1",
    "chainId": "nova-private-1",
    "validator": "nova1...",
    "validatorKeyEncrypted": true,
    "advertisedUrl": "http://10.99.0.11:4101",
    "height": 0,
    "blockHash": "64 位小写 SHA-256",
    "blockTimeMs": 1500,
    "validators": 3,
    "quorum": 2,
    "peerAuthentication": "ed25519-v1",
    "peers": 2,
    "mempoolSize": 0
  },
  "signature": "Base64 Ed25519 签名"
}
```

签名载荷是在响应的 `challenge`、`timestamp` 和完整 `status` 之外加入 `domain: nova-signed-status` 与 `version: 1` 的 canonical JSON。验证端必须使用 deployment 和 genesis 指定的验证者公钥，核对 challenge、30 秒时间窗、chain ID、节点身份、创世 URL、区块参数、验证者数量、quorum、peer 认证及所有字段类型；额外或缺失字段会被拒绝。challenge 使截获的旧响应无法回答新查询，独立 domain 防止状态签名与交易、区块或 peer 请求签名混用。

有效签名只表示指定验证者在该时刻声明了这个本地状态。它不提供 TLS 保密、节点可用性保证或生产级共识证明；远程决策仍须比较多个验证者并验证其区块链。

## HTTP API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/status` | 节点、链头、quorum 和 mempool 状态 |
| `GET` | `/status/signed?challenge=UUID` | 返回供远程运维验证的一次性签名节点状态 |
| `GET` | `/overview` | 浏览器所需的供应、验证者、交易数和链头摘要 |
| `GET` | `/accounts/:address` | 查询已提交余额和 nonce |
| `GET` | `/transactions?limit=20&address=nova1...` | 查询最近交易，可按账户过滤 |
| `GET` | `/transactions/:id` | 查询 pending、committed 或 not_found 交易回执 |
| `GET` | `/records?owner=&hash=&category=&limit=20` | 查询已提交 record，可按作者、SHA-256 和分类过滤 |
| `GET` | `/records/:transactionId` | 读取单条已提交 record 回执 |
| `GET` | `/blocks?from=0&limit=20` | 按高度读取区块 |
| `GET` | `/blocks/:heightOrHash` | 按高度或哈希读取单个区块 |
| `POST` | `/transactions` | 提交完整签名交易 |
| `POST` | `/proposals` | 验证者之间请求区块投票；强制 peer 认证 |
| `POST` | `/proposals/recover` | 携带发送者有效锁证明重试原 proposal；强制 peer 认证 |
| `POST` | `/blocks` | 验证者之间传播已提交区块；强制 peer 认证 |

所有接口目前都只允许放在受控本机或私网环境中，没有公网安全承诺。

record 查询当前从新到旧扫描签名区块，不维护额外状态索引。这样保持状态根向后兼容并减少重复权威数据，但查询成本随链长度线性增长；进入大规模使用前必须增加可重建索引。

节点仅对 `http://localhost:<port>` 和 `http://127.0.0.1:<port>` Origin 返回 CORS 授权头。该策略用于允许本地浏览器跨端口只读查询，不构成节点认证；来自其他来源的请求不会获得浏览器跨域授权。

## 节点配置与部署拓扑

历史 version 1 节点配置把监听地址同时视为验证者 URL。version 2 配置新增 `advertisedUrl`：`listenHost` 只决定本机 HTTP server 绑定的接口，`advertisedUrl` 必须等于创世验证者 URL，供其他节点连接。这样节点可以绑定私网接口或 `0.0.0.0`，而不会把不可路由的未指定地址写进创世。

网络拓扑 version 1 是不含秘密的初始化输入，使用精确字段集合。它必须声明 `private-network-required`、3 至 20 个验证者、唯一 HTTP origin、匹配的监听端口，以及水龙头和每个验证者各自唯一的密码环境变量名。数字形式的公网 IPv4/IPv6 地址会被拒绝；私有 DNS 名称是否真正只在私网解析仍由操作者保证。初始化会在写盘前验证所有密码至少 12 位且值彼此不同。

`nova-validator-bundle` version 1 是带 canonical JSON SHA-256 校验和的单文件部署包。它只包含共同创世、一个 version 2 节点配置和该验证者的加密 keystore。创建只允许在高度 0 且节点目录未被运行进程占用时执行；安装采用临时目录后原子改名，并拒绝覆盖非空目录。bundle 是敏感的加密密钥载体，不是链备份，也不能安装两次。

## 链备份

`nova-chain-backup` v1 包含创世配置、从高度 0 开始的完整区块链、创建时间和 canonical JSON 校验和。验证过程会重建创世块、验证每个区块的提交签名并确定性重放状态。备份不包含账户、节点私钥、mempool 或未完成投票。

以 `--network` 创建备份时，运行时先验证每个验证者目录的创世、身份、配置和完整链，再比较所有有效链的共同前缀。所有较短链必须是最高链的严格前缀；检测到配置错误、无效区块或共同高度哈希不同时拒绝备份。通过后选择最高的已验证节点作为快照来源。该选择不改变 `nova-chain-backup` v1 的持久化格式。

拓扑初始化目录中的节点 home 是部署前副本；节点被分发后这些副本不再代表远端实时链。因此检测到 `private-network-required` deployment manifest 时，`backup create --network` 会拒绝生成误导性旧快照。

多设备网络使用 `backup create --deployment`：先向所有配置节点发送不同的随机 challenge，验证签名状态，并要求至少 `ceil(2N/3)` 个验证者在线且不存在同高度冲突链头；任何可达节点返回无效签名状态都会立即拒绝。随后从每个已认证节点按签名高度分页下载只读区块，分别构造并完整验证临时 `nova-chain-backup` v1，包括所有提交签名与确定性状态重放。至少 quorum 份完整链必须通过验证，且较短链必须是最高链的严格前缀，才会原子写出最高的共同链。单个节点不可达或单份区块下载失败可以由其余 quorum 覆盖，但会在结果中记录。

远程过程不会读取验证者私钥，也不会修改远端节点；生成文件保持 `nova-chain-backup` v1 兼容。当前实现为每个候选设置 100 万区块、128 MiB 累计下载、单状态响应 64 KiB 和单区块页 32 MiB 的内存安全上限，适合个人原型规模，不能替代增量快照数据库。

## 本地持久化与独占锁

`chain.json` 是节点恢复派生状态的权威日志。每次加载都会从创世状态验证并重放完整链，再重新写入 `state.json`；现有 `state.json` 不作为可信输入。

`mempool.json` 只保存未最终确认的候选交易，不是权威历史。启动时节点以重放后的已提交状态为起点，按文件顺序重新执行每项交易：仍然有效的候选保留，已经提交、nonce 冲突、重复、签名无效或其他无法执行的项丢弃；JSON 损坏或顶层不是数组时安全重置为空。清理后的结果在监听端口前原子回写，因此“区块已落盘但 mempool 尚未清理”的断电窗口不会阻塞重启出块。

`votes.json` 是防止验证者在同一高度签署不同提议的安全锁，不能像 mempool 一样随意丢弃。启动时，已低于或等于签名链头的锁属于提交后的清理残留，可以删除；唯一允许保留的是下一高度的锁，而且其完整 proposal、哈希、本验证者身份与 Ed25519 vote 必须全部通过当前链头和状态验证。锁格式损坏、签名无效或指向更远高度时节点拒绝启动，要求操作者从可信备份恢复，避免在不确定是否已经签过票时再次签名。

节点会在启动日志中输出被丢弃的 mempool 项、已提交投票锁和 mempool 格式恢复计数。它不记录交易内容或私钥。

节点数据目录在加载前必须排他取得 `node.lock`。锁格式版本 1，记录 PID、随机实例 ID 和启动时间。活动 PID 的锁拒绝第二个写入者；确认 PID 已死亡后允许回收。备份恢复遵循同一锁协议。锁属于本地运行时安全边界，不属于链上共识或签名协议。

正常停止采用单向生命周期，顺序固定为：标记 `stopping` 并拒绝创建新后台任务；清除 producer/sync timers；关闭 HTTP server 并等待在途请求完成；等待已登记的 transaction gossip、同步、出块和投票锁恢复 promise 全部 settle；最后释放 `node.lock`。同一实例上的重复 stop 共享同一排空过程。锁释放后实例标记为永久 stopped，不能重新监听、启动后台任务或通过节点 mutation 方法写 home；恢复运行必须创建新的 `NovaNode` 并重新取得锁。

这保证旧实例的异步 writer 不会在新实例取得相同 home 后继续落盘。进程被操作系统强制终止时无法执行优雅排空，下一次启动仍依赖原子文件、陈旧 PID 锁回收、签名链重放和上述非最终状态恢复。
