# ADR 0015：以只读 preflight 给新手一个安全下一步

- 状态：接受
- 日期：2026-08-11

## 背景

v0.13 与 v0.14 已经能严格记录七日 readiness 证据，并把当天备份合并进同一命令。但没有区块链经验的所有者在打开终端后仍需自行判断网络是否健康、今天是否已经登记、journal 是否属于当前链，以及下一条命令是什么。直接自动创建交易、修复 journal 或索取密码会扩大安全边界，也会污染“真实使用”证据。

## 决策

增加 `readiness preflight --network|--deployment`。它复用现有 strict doctor 与 journal v1 验证，只读报告 `Europe/London` 当日状态、网络摘要、试验进度和唯一 `nextAction`。journal 不存在是正常的 `NOT_STARTED`，仅在内存构造空摘要，不触碰磁盘。

状态集合固定为 `NOT_STARTED`、`IN_PROGRESS`、`RECORDED_TODAY`、`READY`、`BLOCKED`、`DAMAGED` 和 `WRONG_NETWORK`。损坏 journal、网络阻塞和错误 chain ID 的优先级高于普通进度，避免给出危险或误导性的继续操作建议。

状态 0 表示检查成功并可按建议继续；状态 2 表示当前网络健康阻塞操作；状态 1 表示 journal 损坏、chain ID 不符或命令错误。JSON 使用 `nova-readiness-preflight` version 1 合同。人类与 JSON 输出都只给一个建议，不包含密码。

## 安全边界

- 不创建或修改交易、备份、journal、lock、网络配置或节点状态。
- 不自动修复、删除、覆盖或迁移损坏 journal。
- 不把 `READY` 或状态 0 描述为公网、真实资金、生产 BFT 或三设备验收许可。
- 网络检查可以发送只读 HTTP/RPC 请求；它不读取远端私钥或构造签名交易。

## 结果

所有者可以从一条稳定命令开始每天的流程，脚本也能区分成功检查、网络阻塞和数据错误。代价是新增一个版本化输出合同与状态优先级，需要针对每个状态保持回归测试。它降低操作认知负担，但不会生成任何一天的真实 readiness 证据。
