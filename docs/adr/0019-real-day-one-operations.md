# ADR 0019：用真实 Day 1 修正安全 CLI 与运维反馈

- 状态：接受
- 日期：2026-08-11

## 背景

所有者在本地三验证者网络完成首笔文件存证和 readiness Day 1 后，发现三个自动测试没有提前暴露的操作问题：第二个 PowerShell 无法继承安全网络启动器的密码环境，因而仍需手工复制多行秘密处理代码；readiness 的人类输出把备份 `snapshotHash` 标成 `Backup head`；`npm.cmd run setup` 使用可更新清单的 install 路径，真实执行后意外加入了 `nova-chain: file:..`。

链、journal 和备份本身均通过验证。修复必须保留真实 Day 1 数据，不得用重新初始化、重复登记或测试证据替代它。

## 决策

新增 `npm.cmd run nova:cli:prompt -- <CLI_ARGS>`。PowerShell 以 `ValueFromRemainingArguments` 收集参数数组，并直接调用 `node src/cli.js @ForwardedArguments`。实现不使用 `Invoke-Expression`、`Start-Process`、字符串拼接命令或额外 shell，因此空格、分号等字符不会被二次解释。

该入口 dot-source v0.18 的 `Invoke-WithNovaPassword`，复用遮罩输入、至少 12 字符、仅 child 环境可见、finally 删除环境变量和 BSTR 清理。启动器自己读取的 SecureString 在退出时释放。底层环境变量入口继续保留给明确承担清理责任的自动化。

readiness 人类输出的 `Backup head` 改为打印 `backup.blockHash`；`snapshotHash` 仍保存在备份和 journal 中，用于校验完整快照，但不得冒充区块哈希。

项目 setup 改为 `npm --prefix explorer ci`。Explorer package 和 lock 清除意外的父包本地链接，自动测试锁定根包/Explorer 版本一致性与不存在 `file:..` 漂移。

## 安全边界

- 参数数组避免 shell 字符串注入，但用户仍可主动请求 CLI 支持的任何命令；它不是授权系统。
- CLI child 必须在运行期间取得 `NOVA_KEY_PASSWORD` 才能解密 keystore，继承环境的内存边界与 ADR 0018 相同。
- `Ctrl+C` 或正常异常路径执行 finally。若强制终止整个 PowerShell 进程，只能依赖操作系统销毁该进程环境，不能声称 finally 已执行或所有托管内存已物理清零。
- 不设置统一超时，因为备份、远程诊断和本地交易具有不同的合法耗时；写操作中途强杀比等待用户明确取消更危险。
- setup 的可复现性以已提交 lockfile 为边界；更新依赖仍必须通过独立、显式的维护 PR。

## 验证

测试使用注入 SecureString 与 command action，确认完整参数序列（包括空格和分号）原样到达、动作期间密码可见、退出后环境消失且 child exit code 保留。独立测试用不同的 block/snapshot hash 锁定显示字段，并验证 setup 命令、版本和 Explorer lock 中没有父包链接。全量测试与 Explorer 构建不读取真实密码或 `.nova/`。

## 结果

第二终端的加密操作从多行秘密生命周期代码缩减为一个统一入口，readiness 输出能准确区分区块与快照哈希，首次安装不再污染仓库。真实 readiness 仍坚持每天一笔有意义的最终交易和同日备份；v0.19 不生成或补录 Day 2。
