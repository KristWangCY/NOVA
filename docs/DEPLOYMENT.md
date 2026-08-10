# NOVA v0.12 三设备部署手册

本手册用于准备首次真正的三设备私人网络。v0.12 已提供配置、身份分发、签名远程诊断、quorum 链备份、崩溃状态清理、常见投票锁恢复和优雅停机，但实际私网尚未替你创建。不要跳过“私网与防火墙”步骤，也不要把节点端口映射到公网。

## 1. 前置条件

- 一台只用于初始化的可信电脑，以及三台将长期运行 node1、node2、node3 的设备。
- 四台设备均安装 Node.js 22+，并拥有同一份 NOVA 源码。
- 三台验证设备通过同一个受控私网覆盖互通，获得稳定地址；只允许该私网访问 TCP 4101、4102、4103。
- 每台设备系统时钟自动同步，彼此误差必须小于 30 秒。
- 密码管理器中准备四个彼此不同、至少 12 位的高强度密码。

私有 IPv4 地址范围由 [RFC 1918](https://www.rfc-editor.org/rfc/rfc1918.html) 定义；地址是私有的并不自动意味着网络安全，仍要配置路由、防火墙或 VPN。NOVA 当前节点 HTTP 没有 TLS 保密性。

## 2. 创建公开拓扑

在初始化电脑执行：

```powershell
node src/cli.js network template --out .nova/nova-topology.json
```

编辑三个 `url` 和 `listenHost`。`url` 是其他验证者实际连接的固定私网 origin；`listenHost` 是该设备本地绑定的私网接口。优先绑定精确私网 IP；只有确认设备防火墙正确时才使用 `0.0.0.0`。端口必须一致。

拓扑文件不含密码，可以审阅和备份，但不要给它添加 `password`、token 或恢复短语字段；解析器会拒绝任何额外字段。仓库也提供 [三设备示例](examples/three-device-topology.json)。

## 3. 原子生成网络

在初始化电脑设置四个密码。示例文字必须换成密码管理器生成的真实密码：

```powershell
$env:NOVA_FAUCET_PASSWORD = "独立水龙头密码"
$env:NOVA_NODE1_PASSWORD = "独立节点一密码"
$env:NOVA_NODE2_PASSWORD = "独立节点二密码"
$env:NOVA_NODE3_PASSWORD = "独立节点三密码"

node src/cli.js network init `
  --dir .nova/distributed `
  --topology .nova/nova-topology.json
```

缺少、过短或重复密码会在创建目录前失败。成功后，立即把四个密码保存到密码管理器并清除当前 PowerShell 环境变量。

## 4. 创建与验证单节点 bundle

```powershell
node src/cli.js bundle create --network .nova/distributed --node node1 --out .nova/node1-bundle.json
node src/cli.js bundle create --network .nova/distributed --node node2 --out .nova/node2-bundle.json
node src/cli.js bundle create --network .nova/distributed --node node3 --out .nova/node3-bundle.json

node src/cli.js bundle verify --file .nova/node1-bundle.json
node src/cli.js bundle verify --file .nova/node2-bundle.json
node src/cli.js bundle verify --file .nova/node3-bundle.json
```

bundle 包含一把加密私钥，仍属于敏感文件。通过加密移动介质或已经认证的私有传输分别送到对应设备；不要使用聊天附件、公开网盘或 Git。node1 bundle 只能安装一次并且只能交给 node1 设备，其余同理。

## 5. 在每台设备安装

以下以 node1 为例，在 node1 设备的 NOVA 仓库目录执行：

```powershell
node src/cli.js bundle verify --file C:\secure-transfer\node1-bundle.json
node src/cli.js bundle install `
  --file C:\secure-transfer\node1-bundle.json `
  --home .nova/node1

$env:NOVA_NODE1_PASSWORD = "从密码管理器读取节点一密码"
node src/cli.js node start --home .nova/node1
```

node2 和 node3 使用各自 bundle、home 和环境变量。先启动三个节点。回到能访问该私网的受信任初始化电脑，不要依靠人工查看裸 `/status`，而是执行：

```powershell
node src/cli.js doctor --deployment .nova/distributed
```

应显示 3/3 个验证者签名在线、相同 chain ID 和相同链头。该命令会为每台节点生成新的 challenge，并按创世公钥、预期 URL 和 30 秒时间窗验证完整状态；不需要设置任何节点密码。

## 6. 首次验收

在写入真实 record 前必须完成：

1. 三个节点都在线并报告各自正确的 `advertisedUrl`。
2. 从 node1 提交一笔最小测试转账或 record，三个节点最终出现相同交易和区块哈希。
3. 停止任意一个节点，剩余两个仍能达到 2-of-3 并确认交易。
4. 停止全部节点后只启动 node1 并提交测试交易，确认它不会单独提交；再启动 node2，确认两台自动达到最终确认且没有手工删除投票锁。
5. 重启停止的 node3，确认它通过只读区块同步追上同一链头。
6. 每一步都运行 `doctor --deployment .nova/distributed --json`，保存签名诊断结果。
7. 校准三台设备时钟，并保存首次验收日志。

这些步骤必须在真实设备上完成；同机自动测试不能作为替代证据。

## 7. 远程链备份

`.nova/distributed` 中的本地 node home 是初始化副本，不是远端实时数据；工具会拒绝对它执行 `backup create --network`。三台远端节点保持运行，在受信任管理电脑执行：

```powershell
node src/cli.js doctor --deployment .nova/distributed
node src/cli.js backup create `
  --deployment .nova/distributed `
  --out .nova/backups/nova.json `
  --timeout 5000
node src/cli.js backup verify --file .nova/backups/nova.json
```

远程备份会验证所有可达节点的一次性签名状态，从每个已认证节点分页读取到其签名链头的区块，逐块验证共识签名并重放状态。至少两份完整链必须通过验证且共享历史，才会原子写出最高共同链；一台不可达会记录警告但不阻断。任何可达节点返回无效签名状态、相同高度冲突链头，或完整有效链少于两份都会拒绝。

生成文件仍不包含私钥，并与现有 `backup restore` 兼容。四个原始 keystore、四个密码和初始 bundle 需要分别做离线加密备份；不要把密码与对应 keystore 放在同一存储介质。首次部署还必须实际演练：停止一台节点后创建 quorum 备份、重新启动并追赶、再把已验证备份恢复到空闲的同创世节点 home。同机自动测试已经覆盖这些安全判断，但不能替代真实设备演练。

## 8. 当前禁止事项

- 禁止路由器端口转发、云安全组公网放行或公开 DNS 指向节点 HTTP。
- 禁止把同一 validator bundle 安装到两台机器；这会制造双签风险。
- 禁止在节点已开始出块后重新创建 bootstrap bundle。
- 禁止把 bundle、水龙头 keystore 或密码提交到 Git。
- 禁止把私网 IP、请求签名或 CORS 当成 TLS 加密。
