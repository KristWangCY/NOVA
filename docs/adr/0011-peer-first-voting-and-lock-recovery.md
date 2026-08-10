# ADR 0011：peer-first 自签门槛与持久化提议锁恢复

- 状态：已接受
- 日期：2026-08-10

## 背景

NOVA 的单轮投票锁保证正常验证者在同一高度只签一个 proposal。v0.10 已能验证和保留该锁，但旧出块顺序是“提议者先给自己投票，再请求 peers”。当一台设备先启动、其他设备暂不可达时，它会独自锁定一个无法达到 quorum 的 proposal；之后若只有另一台设备恢复，双方可能因不同 slot proposal 而无法组成 2-of-3。peer 已签名但响应丢失时，合法 proposal 也没有自动重试路径。

这是 crash-fault 私人网络中的实际活性缺口。直接删除锁或允许任意新 proposal 覆盖锁会恢复活性，却破坏防双签安全，不能接受。

## 决策

### 1. 提议者最后写入自己的 vote

轮值提议者先创建带 proposer signature 的完整 proposal，并并发请求所有 peers 投票，但此时不调用本机 `signProposal`。每张返回 vote 都按 proposal 的 `{chainId, height, slot, blockHash}`、genesis 公钥和 validator 地址验签，并按地址去重。

只有至少 `quorum - 1` 张不同、非本节点的有效 vote 已经到达，提议者才持久化自己的 vote lock。随后重新验证包含本机 vote 的完整集合；达到 quorum 才组装、验证、提交和广播 block。quorum 为 1 的显式单节点开发 fixture 不需要 peer vote。

因此无同伴、仅 HTTP 可达、伪造 vote、重复 vote 或错误 proposal vote 都不会让提议者自锁。peer 可能先锁定 proposal；若提议者随后崩溃，由恢复协议接管。

### 2. 持锁验证者可以携证明重试同一 proposal

新增 peer-authenticated `POST /proposals/recover`，正文采用精确字段 version 1：`version`、`proposal`、`proofVote`。请求的 `proofVote` 必须：

- 是 genesis 验证者对该 proposal 的有效 Ed25519 vote；
- `validator` 等于 `ed25519-v1` 请求认证中的发送者；
- proposal 仍扩展接收者当前 committed tip，并通过 proposer signature、交易执行和状态根验证。

接收者未在该高度投票时可签署有效历史 proposal；未来超过本机 `currentSlot + 1` 的 proposal 仍拒绝。接收者已有相同 hash 锁时返回原 vote，已有不同 hash 锁时失败，绝不替换或解锁。

每个节点发现 `tip.height + 1` 有合法持久锁时，以有界周期向 peers 发送恢复请求。自身证明加上返回的有效唯一 votes 达到 quorum 后，任何持锁节点都可提交并广播该 block。

### 3. 明确保留非 BFT 边界

该机制能自动处理：

- 一台节点先启动且 peers 尚不可达；
- peer 已投票但响应或原提议者丢失；
- 两个验证者锁在不同 proposal、第三个验证者尚未锁定。

它不是 PBFT/Tendermint view-change。如果所有验证者都已经锁在互不相同的 proposal，单轮锁规则没有安全解锁证明，网络仍会停止。2-of-3 的两个 quorum 只交叉一个验证者；该交叉验证者 Byzantine 双签时仍可能形成冲突提交。此边界继续由 ADR 0001 约束。

## 后果

优点：

- 隔离提议者不再仅凭本地计时事件制造持久锁。
- 错峰启动时只要第二个验证者加入，就能恢复 2-of-3 出块，不依赖第三台设备先上线。
- 已经签名的 proposal 和 vote 成为恢复证明，不需要丢弃安全锁。
- 所有网络 vote 在本机自签前验真，缩小伪造响应造成的活性攻击面。

代价与限制：

- 出块必须先等待至少 `quorum - 1` 个 peer 响应，延迟比先自签略高，但本机签名不是瓶颈。
- 持锁节点会周期发送恢复请求；当前使用既有 request timeout，没有独立指数退避或指标。
- 恢复请求是新的内部协议 surface，必须保留 version、精确字段、peer 身份绑定和端到端测试。
- 完整网络分区、三重冲突锁、恶意双签仍需成熟共识或人工安全恢复。

## 被否决的方案

- **保留先自签，只在超时后删除锁**：会允许同一验证者在同高度签不同 proposal。
- **任何可达 HTTP peer 都算 readiness**：可达不等于返回有效 validator vote，假服务可诱导自锁。
- **恢复时允许换成当前 slot 的新 proposal**：缺少 view-change 证明，等价于主动双签风险。
- **必须由原提议者恢复**：原提议者正是最可能崩溃的节点；任何拥有自己合法 vote 的验证者都应能驱动同一 proposal。
- **把单轮恢复称为 BFT view-change**：能力和安全证明都不满足，必须保持原型边界透明。
