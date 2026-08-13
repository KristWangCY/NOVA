# NOVA v0.20 安全运维手册

这份手册以当前“所有节点运行在同一台 Windows 电脑”的日常自用阶段为主，也记录 v0.20 私网多设备的远程诊断、备份和七日 readiness 入口。它不适用于公网部署。

v0.20 已能生成多设备拓扑和单验证者 bundle，从受信任管理电脑验证远端签名状态、取得 quorum 链备份，在断电重启时清理非最终残留状态，恢复常见的持久化提议锁，在退出前排空后台写任务，以只读 preflight 区分首次初始化、停机、故障和恢复路径，并用遮罩密码命令分别启动网络和执行加密 CLI；所有者已完成两个连续真实使用日，但在七日试用和三台实际设备验收完成前，日常流程仍以单机网络为准。多设备准备请严格按 [三设备部署手册](DEPLOYMENT.md) 操作。

v0.20 的空闲网络不再创建心跳空块。只要节点 API 可达、doctor 健康且 mempool 为零，高度长时间不变就是“正常空闲”。判断节点是否停止必须看 `/health`、Explorer 连接状态或 doctor，不能再把“最新区块时间很久”单独当成故障。交易进入 mempool 后，网络仍会在下一个合格 slot 尝试最终确认。

滚动升级期间，尚未升级的 v0.19 节点仍可能提出合法空块；v0.20 节点会接受它以保持共同历史。因此只有全部验证者升级并重启后，网络才完全停止新增空块。Explorer 的“正常空闲”表示当前连接节点可达且本地 mempool 为空，不保证旧版本 peer 不会随后提出空块。mempool 不按手续费竞价筛选：交易入池前已按当前状态和队列顺序验证，提议按 FIFO 每块最多取配置上限，剩余交易留待下一块；未达 quorum 时会在后续合格 slot 重试，但完整 Byzantine 活性仍不在当前原型保证内。

## 1. 首次创建

在 PowerShell 中执行：

```powershell
npm.cmd run setup
npm.cmd run nova:secure:prompt
```

密码输入会被遮罩。启动器不会把密码写入父 PowerShell 环境、命令历史或磁盘；它只在运行期间把密码交给启动器和 Node 子进程，退出时删除子进程环境变量并释放临时 BSTR 缓冲区。这不等于能够保证 CLR 或 Node.js 管理内存中每一份副本都被物理清零；同一用户或更高权限的恶意进程也不在该启动器的保护边界内。初始化先在临时目录完成所有密钥加密和配置写入，成功后才整体移动到 `.nova/private`。密码缺失、少于 12 个字符或写入失败不会留下可被误判为完整网络的目标目录。

创建后立即把密码保存进密码管理器，并对下列内容做离线加密备份：

- `.nova/private/faucet-key.json`
- `.nova/private/node1/node-key.json` 至 `node3/node-key.json`
- `.nova/private/genesis.json`
- 密码本身，存放位置应与 keystore 备份分离

不要把 `.nova/` 提交到 Git、发送到聊天工具或放进未加密网盘。

## 2. 日常启动与停止

每次启动都运行同一个遮罩命令：

```powershell
npm.cmd run nova:secure:prompt
```

默认命令不会修改父 PowerShell 的 `NOVA_KEY_PASSWORD`，因此停止后无需手工清除。另一个 PowerShell 中需要解锁私钥的命令使用 `npm.cmd run nova:cli:prompt -- <CLI_ARGS>`；它同样遮罩读取密码、以参数数组直接调用 CLI 并在退出后清理。若自动化流程直接使用 `npm.cmd run nova:secure` 或 `node src/cli.js` 并自行设置环境变量，则自动化流程必须在完成后清除它。

看到三个节点都输出 `listening` 后再开始转账。NOVA Explorer 只应通过 `http://127.0.0.1:3100` 打开；K&M 继续使用 3000。启动器会先检查 3100 是否空闲，如需覆盖可在当前会话设置 `NOVA_EXPLORER_PORT`，但只能选择 1024–65535 且不能使用节点端口 4101–4103。正常停止使用一次 `Ctrl+C`，等待进程自行退出后再关机；不要看到端口关闭就立即强杀进程。节点会先停止接收新请求，再等待在途 gossip、同步、出块和投票锁恢复任务结束，最后才释放 `node.lock`。网络超时默认有界，正常排空可能需要数秒。

每个节点启动时会独占创建 `node.lock`。同一个节点目录不能被第二个进程启动，备份恢复也不能与活动节点并发写入。异常关机留下的锁会在下一次启动时检查 PID；只有确认原进程已经死亡后才会自动替换。不要在节点仍运行时手工删除锁文件。

重复按 `Ctrl+C` 不会开启第二套清理流程；同一进程复用已经停止的 Node 实例也会被拒绝。若必须强制结束卡住的进程，先保存控制台和 PID，下一次启动后立即运行 doctor；强杀无法获得优雅停机保证。

断电重启时，节点会先重放签名链，再检查非最终状态。已经上链、重复、签名损坏或 nonce 失效的 mempool 项会被删除，仍有效的 pending 交易会保留并继续等待出块；损坏的 mempool JSON 可以安全清空。日志出现 `recovered volatile state` 表示执行了这种自动修复，应保存该行并在启动后运行 doctor。

投票锁不同：它用于阻止验证者在同一高度双签。只有已经被链头覆盖的旧锁会自动删除；下一高度投票的 proposal 或签名若损坏，节点会拒绝启动。此时不要手工删除 `votes.json`，因为无法证明该验证者未签过另一提议；先隔离该设备，验证其余节点链头，再从同创世可靠备份和保留的 validator bundle 执行恢复。

有效投票锁不会因一次响应丢失永久停住：节点会携带自己的 Ed25519 vote 证明周期重试完全相同的 proposal。日志短暂出现 `locked proposal ... did not reach quorum` 表示当前没有另一张兼容票，常见于同伴尚未启动；peer 恢复后应自动提交。若全部节点在线后该日志持续多个 slot，停止提交新业务，保存三台日志并运行远程 doctor；当前原型没有处理“三台均锁在三个不同 proposal”的完整 view-change，禁止靠删除 `votes.json` 强行解锁。

## 3. 健康检查

```powershell
npm.cmd run doctor
```

推荐在启动后、重要转账前和备份前运行。诊断会同时检查：

- 根创世文件和每个节点保存的创世文件完全一致。
- 验证者密钥、节点编号、监听地址和 peers 与创世验证者集合一致。
- 每个节点的完整签名链都能从创世状态确定性重放。
- 三个节点保存的链共享同一历史；磁盘高度差只会警告，历史分叉会失败。
- 设置密码环境变量时，三个验证者 keystore 都能真正解锁。
- 网络运行时，三个 API 身份正确且位于同一高度、同一区块哈希。
- 在线节点明确报告 `ed25519-v1` peer 请求认证能力。

`HEALTHY` 表示所有检查通过；`HEALTHY WITH WARNINGS` 常见于网络已停止或节点正在短暂同步；`ATTENTION REQUIRED` 表示至少一项失败，此时不要继续重要操作或制作备份。自动化环境可增加 `--require-online --json`，要求全部节点在线并读取机器可解析结果：

```powershell
node src/cli.js doctor --network .nova/private --require-online --json
```

如需逐节点查看原始状态，仍可使用 `node src/cli.js status --url http://127.0.0.1:4101`，依次替换端口为 `4102`、`4103`。

多设备网络不要人工相信三个裸 `/status` 页面。请在能访问同一私网、并持有初始化目录 `genesis.json` 与 `deployment.json` 的受信任管理电脑运行：

```powershell
node src/cli.js doctor --deployment .nova/distributed
node src/cli.js doctor --deployment .nova/distributed --timeout 3000 --json
```

命令为每个节点生成不同的一次性 challenge，并用创世公钥验证返回的完整状态。三节点全部通过显示 `HEALTHY`；只有两台通过显示警告但 `operational: true`；少于两台、同高度不同区块哈希，或可达节点返回伪造/过期状态时显示 `ATTENTION REQUIRED`。不同高度可能只是同步过程，会警告；制作备份时仍会进一步下载并核验完整共同历史。

验证者的内部写请求会签署方法、完整路径、原始正文哈希、链 ID、发送者、时间戳和随机请求 ID。当前允许 30 秒时钟偏差；单机运行由同一系统时钟天然满足。未来分散到不同设备时，必须先启用可靠的系统时钟同步，并把节点 HTTP 放进私网覆盖或 mTLS。请求签名不是加密，抓包者仍能看到明文内容。

## 4. 文件存证与验证

先确认网络是 `HEALTHY`。以下命令只读取文件字节并计算 SHA-256，不会把文件内容或路径发送给节点：

```powershell
npm.cmd run nova:cli:prompt -- record create `
  --key .nova/private/faucet-key.json `
  --file C:\path\to\file.pdf `
  --title "Document proof" `
  --category document `
  --note "公开备注，不要填写秘密" `
  --fee 1
```

等待一个区块后验证：

```powershell
node src/cli.js record verify --file C:\path\to\file.pdf
node src/cli.js record list --category document --json
```

`VERIFIED` 只在 SHA-256 与文件大小都匹配一条最终确认 record 时出现。修改一个字节就会得到不同哈希和 `NOT RECORDED`（进程退出码 2）。浏览器的“验证本地文件”同样不会上传文件，但为避免浏览器一次性内存占用而限制为 64 MiB；大文件使用 CLI。

上链前必须理解：标题、分类、备注、字节数、作者地址和裸 SHA-256 永久可见且无法删除。不要记录密码、恢复短语、医疗信息或其他秘密；不要把链上存证误当成内容真实性、合法性或原创权的自动证明。

## 5. 链备份

```powershell
node src/cli.js backup create `
  --network .nova/private `
  --out .nova/backups/nova-YYYY-MM-DD.json

node src/cli.js backup verify --file .nova/backups/nova-YYYY-MM-DD.json
```

网络级备份会先完整验证三个节点、排除历史分叉，再自动选择最高的可靠链作为来源。任何节点配置损坏或链验证失败都会中止，避免静默保存错误历史。只有随后 `verify` 也成功的备份才可保留。把链备份复制到另一块磁盘；它没有私钥，可以与 keystore 备份分开存放。当前备份是完整链文件，链增长后需要改为数据库快照与增量备份。

多设备网络的初始化节点目录是陈旧副本，不能对 `.nova/distributed` 使用 `--network`。远端实时备份使用：

```powershell
node src/cli.js backup create `
  --deployment .nova/distributed `
  --out .nova/backups/nova-YYYY-MM-DD.json `
  --timeout 5000

node src/cli.js backup verify --file .nova/backups/nova-YYYY-MM-DD.json
```

该命令不需要节点密码或私钥，也不会写入远端。它先验证签名状态，再从每个已认证验证者拉取到其签名链头的完整区块并独立重放。至少两个完整链必须有效且共享前缀；三台中的一台不可达仍可备份。可达节点返回无效签名状态、同高度冲突、少于 quorum 份完整链或历史分叉都会中止。保留命令输出中的 `observedValidators`、`unavailableValidators` 与 `failedChainDownloads` 作为备份日志。

## 6. 恢复

节点每次启动都会从创世状态重放完整签名链，重新生成 `state.json`。因此派生状态丢失或损坏通常不需要人工修复；只要 `chain.json` 完整，启动会自动恢复。

如果链文件损坏，先停止整个网络，再使用已验证备份恢复单个节点：

```powershell
node src/cli.js backup restore `
  --home .nova/private/node1 `
  --file .nova/backups/nova-YYYY-MM-DD.json
```

恢复会拒绝以下情况：目标节点仍在运行、备份校验失败、创世配置不同，或目标验证者私钥不属于该网络。恢复后先运行 `node verify`，再启动网络观察三个节点是否汇合到同一链头。

## 7. 常见错误

| 错误 | 含义与处理 |
| --- | --- |
| `Password must contain at least 12 characters` | 密码过短；重新运行 `npm.cmd run nova:secure:prompt` 并输入至少 12 个字符。 |
| `set $env:NOVA_KEY_PASSWORD` | 你直接运行了需要解锁私钥的底层 CLI；日常操作请改为 `npm.cmd run nova:cli:prompt -- <CLI_ARGS>`。 |
| `unable to decrypt keystore` | 密码错误或文件损坏；停止重试，核对密码与离线备份。 |
| `node home is already in use` | 节点正在运行；不要删除锁，找到并停止原进程。 |
| `ATTENTION REQUIRED` | 查看所有 `[FAIL]` 行；修复前不要转账或备份。 |
| `network is not safe to back up` | 至少一个节点配置、签名链或共同历史未通过验证；先运行 `doctor --offline`。 |
| `stored chain does not match genesis` | 链目录与创世文件不匹配；使用同一网络的已验证备份恢复。 |
| 三个节点长期不同高度 | 停止网络，逐个执行 `node verify`，保存日志后再诊断。 |
| 没有交易时高度长时间不变 | v0.20 的正常按需出块行为；用 Explorer、`/health` 或 doctor 确认节点在线，不要为制造高度而提交无意义交易。 |
| `NOT RECORDED` | 当前文件字节与任何已提交 record 不匹配；核对网络、文件版本和最终确认状态。 |
| `peer request timestamp is outside the acceptable window` | 节点系统时钟相差超过 30 秒；校准时钟后再恢复通信。 |
| `peer request was already received` | 同一内部请求被重复发送；节点已拒绝重放，持续出现时检查代理或网络重试。 |
| `remote backup requires authenticated validator quorum` | 有效签名状态少于 2-of-3，或发现同高度冲突；不要改用单节点绕过，先恢复连接并运行远程 doctor。 |
| `invalid signed status` | 配置地址可达，但响应不能由预期验证者和本次 challenge 验证；按安全事件处理，检查地址、时钟、部署文件和节点身份。 |
| `complete remote chains passed verification` | 状态已认证，但完整链下载或重放后不足 quorum；检查失败节点日志和磁盘，不要保留未完成输出。 |
| `persisted validator vote lock ... invalid` | 防双签锁损坏或与当前链不一致；节点已失败关闭。不要删除锁后强启，应隔离并按已验证链备份恢复该验证者。 |
| `recovered volatile state` | 节点在断电恢复时清除了非最终 mempool 残留或已提交投票锁；随后运行 doctor 并确认 pending/committed 回执。 |
| `locked proposal ... did not reach quorum` | 本节点保留安全投票锁但暂时没有兼容同伴票；先恢复至少另一节点和网络连接。全部在线后仍持续出现时保存日志并停止业务，不要删除 `votes.json`。 |

## 8. 七日自用 readiness

每天先运行只读 preflight。它会检查网络与 journal、显示当天状态，并只给一个下一步；没有 journal 时不会创建任何文件：

```powershell
node src/cli.js readiness preflight --network .nova/private
```

| 状态 | 含义 | 进程状态 |
| --- | --- | --- |
| `NOT_INITIALIZED` | source 缺失或为空且没有 journal；可以按引导首次初始化 | 0 |
| `NOT_STARTED` | 网络健康，但还没有 readiness journal | 0 |
| `IN_PROGRESS` | 已有有效历史，今天尚未登记 | 0 |
| `RECORDED_TODAY` | 今天已经登记，不要重复提交 | 0 |
| `READY` | 已有至少七个连续有效日期 | 0 |
| `BLOCKED` | 当前网络健康不允许继续 | 2 |
| `DAMAGED` | journal 格式、哈希或历史验证失败 | 1 |
| `WRONG_NETWORK` | journal 的 chain ID 与当前网络不同 | 1 |

`NOT_INITIALIZED` 只适用于真正空白的首次使用。非空但不完整的 source 会 `BLOCKED` 并要求保留检查；已有有效 journal 却缺少 source 时会要求恢复原链，绝不建议创建新 chain ID。Preflight 不创建交易、备份、journal、锁或修复，也不会读取或显示密码。状态 0 只表示检查成功并可按建议继续，不表示七日试验已经通过；自动化可使用 `--json` 读取 version 2 结果。

当 preflight 要求产生今天的证据时，完成一笔真正有用途的 transfer 或 record，并用 `tx status` 确认 `final: true`。随后在同一伦敦日期内让 readiness 命令创建备份并登记当天证据：

```powershell
node src/cli.js readiness check `
  --network .nova/private `
  --tx <FINAL_TRANSACTION_ID>

node src/cli.js readiness report --require-ready
```

未满七日时会看到类似结果（hash 与日期以本机实际输出为准）：

```text
NOVA readiness: IN PROGRESS
Chain: nova-local-1
Evidence: 3 day(s), current streak 3/7
Period: 2026-08-11 to 2026-08-13 (Europe/London)
Remaining consecutive days: 4
Journal hash: <64-character SHA-256>
```

最后一条命令在连续七日完成前返回状态 2，这是“尚未就绪”而不是 journal 损坏。不要修改系统日期、复用交易或手工编辑 `.nova/readiness/journal.json` 来补日；命令没有日期参数，并会拒绝重复日期、重复交易、跨链证据和被改动的历史。每天另行保存有意义用途的简短说明，因为 journal 只保存协议摘要，不保存你为什么使用它。

自动备份保存在 `.nova/readiness/backups`。备份链头必须与随后 doctor 观察到的健康链头完全一致；如果期间恰好产生新块，命令最多自动重建三次，并显示实际尝试次数。只有这种精确的链头推进会重试；I/O、签名、校验、doctor 或 degraded network 错误都会立即失败。需要完全手工控制时可以提供 `--backup FILE`，此模式只读该文件且不重试。

readiness journal 和自动备份必须保持私有且不要提交 Git。其 SHA-256 链用于发现意外修改，不是第三方签名或可信时间证明。七日通过后仍然不能承载真实资金或开放公网；它只关闭“这条链能否支持你的每日流程”这一项产品风险。

## 9. 当前不能做的事

- 不能找回遗失密码，也不能在线轮换验证者密钥。
- 不能把 API 改为 `0.0.0.0` 后直接开放公网。
- 不能把 `private-network-required` 当成自动创建的 VPN；它是强制运维条件，不是网络隔离实现。
- 不能把签名状态或 peer 认证当成流量加密；远程诊断和备份端点仍只能位于受控私网。
- 不能把这套 2-of-3 原型当作可承载资金的生产 BFT 网络。
- 不能仅靠链备份恢复资产所有权；私钥与密码必须独立备份。
- 不能撤销或删除已经提交的公开 record 元数据；只能追加更正记录。
- 不能把本地 readiness journal 当作第三方审计证明，也不能把自动测试当成真实七日使用。
