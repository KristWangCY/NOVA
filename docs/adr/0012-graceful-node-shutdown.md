# ADR 0012：排空后台 writer 后再释放节点目录锁

- 状态：已接受
- 日期：2026-08-10

## 背景

`NodeHomeLock` 防止两个节点实例同时写同一个 home。旧 stop 流程会清除 timers、关闭 HTTP server，然后立即释放锁；但 timer 已经触发的同步、出块或投票锁恢复 promise，以及交易接收后异步启动的 gossip，可能仍在等待远端 timeout。部分任务会在等待后提交区块、更新 mempool 或写 vote lock。

这形成一个短暂但真实的竞态：旧实例释放 `node.lock` 后，新实例可以取得相同 home，而旧后台任务随后继续落盘。单个 JSON 文件仍是原子写，但两个内存状态的 writer 交叠会破坏链、mempool 或投票安全，违背 ADR 0004 的单 writer 不变量。

## 决策

### 1. 所有节点后台工作统一登记

节点维护一个当前后台 task 集合。transaction gossip、定时同步、轮值出块和持久化锁恢复都通过同一入口启动：

- stopping/stopped 后拒绝创建新任务；
- promise 无论成功或失败都从集合删除；
- 未处理异常被记录，不成为进程级未处理 rejection；
- 任务内部原有共识和网络错误处理保持不变。

HTTP 请求本身由 Node server 管理；`server.close()` 等待在途连接结束。请求派生的后台 gossip 会在请求返回前登记，因此随后也包含在 task 集合中。

### 2. stop 使用固定排空顺序

首次 stop 创建唯一 stop promise，后续调用返回同一清理结果：

1. 设置 stopping，禁止新后台工作；
2. 清除 producer 和 sync timers；
3. 关闭 HTTP server，等待在途请求完成；
4. 对当前 task 集合反复执行 `Promise.allSettled`，直到集合为空；
5. 释放 `NodeHomeLock`；
6. 标记实例永久 stopped。

网络操作都有节点配置的 timeout，因此正常任务排空有界。任务排空期间锁始终存在，备份恢复和第二 Node 实例继续被拒绝。

### 3. stopped 实例不可复用

锁释放后，原 Node 实例不能再次 start，不能创建后台任务，且 `addTransaction`、`signProposal`、`commitBlock`、同步、出块和锁恢复等 mutation 入口拒绝执行。重新运行必须构造新的 `NovaNode`，重新加载、验证并重放磁盘链，同时取得新的 lock instance ID。

### 4. 强制终止仍走崩溃恢复

SIGKILL、断电、系统崩溃或进程被外部强杀不会执行 promise 排空。下一实例必须继续依赖原子 JSON、死亡 PID 锁回收、签名链重放、mempool 清理和投票锁失败关闭；优雅停机不能被宣传为断电事务。

## 后果

优点：

- 正常 Ctrl+C、服务停止和程序化 stop 不再产生新旧 writer 交叠窗口。
- 重复 stop 幂等，避免两条关闭路径竞争 server 和 lock。
- 停止对象的生命周期明确，减少测试、脚本或未来服务包装器误复用。
- 故障测试可悬停真实后台 writer，直接证明锁的释放顺序。

代价与限制：

- 正常停止可能等待一个或多个网络 timeout，不再保证端口关闭即进程立刻退出。
- 未纳入统一入口的未来后台任务会重新引入风险；新增 timer、fire-and-forget promise 或 writer 时必须加入 task 集合。
- 底层 `NodeStorage` 仍是内部可访问对象，项目代码不得绕过 Node 生命周期在 stopped 实例上直接调用持久化方法。
- 没有替代操作系统服务管理、崩溃重启或数据库事务。

## 被否决的方案

- **关闭 HTTP 后立即释放锁**：端口生命周期不等于后台 writer 生命周期，是原竞态来源。
- **固定 sleep 数秒再释放**：无法证明任务完成，timeout 或未来配置变化会使等待不足或浪费时间。
- **stop 时取消所有 promise**：Node fetch 可取消，但同步取消与已开始的本地提交边界更复杂；先排空更容易验证且保持已登记工作一致。
- **允许 stopped 实例重新 start**：必须重新取得锁并完全重载磁盘状态，复用旧内存对象容易遗漏；创建新实例更安全。
- **只依赖进程退出清理锁**：不能支持同进程内替换、测试、恢复工具或未来 supervisor。
