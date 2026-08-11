# ADR 0016：首次初始化必须与网络故障和恢复分开

- 状态：接受
- 日期：2026-08-11

## 背景

v0.15 的 read-only preflight 假设网络已经初始化。真实 NOVA 工作区尚无 `.nova/private` 和 readiness journal 时，它把空白首次使用报告为 `BLOCKED / repair-network` 并建议 doctor。doctor 可以诊断既有网络，却不能修复一条从未创建的链；这给没有区块链经验的所有者提供了错误下一步。

同时，不能把所有“没有 genesis”的情况都叫首次使用。非空的部分目录可能包含密钥或失败初始化材料；有效 readiness journal 但网络目录丢失意味着应恢复原 chain ID，而不是新建替代链。

## 决策

preflight 输出升级为 `nova-readiness-preflight` version 2，并在 `network` 摘要中增加 `initialized`、`sourcePath` 和 `sourceStatus`。source 状态由只读文件系统观察得到，仅为 `missing`、`empty`、`present` 或 `unreadable`。

状态分类固定如下：

- source 为 missing/empty 且 journal 缺失：`NOT_INITIALIZED`、exit 0、`initialize-network`。
- source 为 missing/empty 且 journal 有效：`BLOCKED`、exit 2、`restore-network`，不得初始化新链。
- source 非空但不能形成有效网络，或不可读：`BLOCKED`、exit 2、`inspect-network-source`。
- journal 损坏：始终优先 `DAMAGED`、exit 1。
- local 网络有效但所有验证者停止：`BLOCKED`、exit 2、`start-network`。
- 其他网络健康问题继续 `BLOCKED / repair-network`。

local 首次使用只建议 `npm.cmd run nova:secure:prompt`；distributed 首次使用只建议创建 public topology template 并遵循三设备部署手册。建议命令在所有者主动执行后可能写入，但 preflight 本身不创建目录、文件、锁、交易、备份或修复，也不读取或输出密码。

## 结果

首次使用从“故障”变为正常产品状态，而部分数据和恢复历史保持 fail-safe。JSON version 1 的消费者必须显式适配 version 2 与 `NOT_INITIALIZED`；这是刻意的不兼容升级，避免旧自动化误解新增安全状态。

该改动不能代替所有者选择并保管密码、初始化真实私链或完成七日试用。它只确保每一步开始前得到正确且不会破坏数据的下一动作。
