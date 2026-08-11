# ADR 0018：单命令遮罩密码启动器

- 状态：接受
- 日期：2026-08-11

## 背景

安全启动原本要求所有者手工执行 SecureString、BSTR 转换、环境变量设置和清理等多行 PowerShell。虽然输入被遮罩，但这条流程对区块链新手过长，容易漏掉清理步骤，也让 v0.16 的 `NOT_INITIALIZED` 引导仍然需要解释大量实现细节。

密码必须由所有者本人创建和保管，不能发给 K&M、Codex、DeepSeek 或写入仓库。首次初始化仍是会创建 `.nova/private` 的显式操作，readiness preflight 继续保持只读。

## 决策

新增 `npm.cmd run nova:secure:prompt` 作为 Windows 日常入口。独立 PowerShell 启动器使用 `Read-Host -AsSecureString` 读取密码，拒绝少于 12 个字符的输入，把明文只放入该启动器进程的 `NOVA_KEY_PASSWORD`，再启动现有 `node scripts/run-nova.js --secure`。

无论子进程成功、失败或抛出异常，启动器都会删除自身的环境变量、把托管字符串引用置空、调用 `ZeroFreeBSTR` 释放临时 BSTR，并释放自己读取的 SecureString。父 PowerShell 从未接收密码，因此密码不进入父环境、命令历史或磁盘。现有 `npm.cmd run nova:secure` 保留给显式设置环境变量的自动化调用者。

`readiness preflight` 的 local 初始化与停机建议更新为新的遮罩入口；preflight 本身仍不读取密码或创建文件。

## 安全边界

- `SecureString` 和 BSTR 缩短了明文暴露范围，但 Node.js 必须取得字符串才能解密 keystore。CLR 与 Node.js 运行时可能复制或延迟回收该字符串，因此不能声称所有内存副本都被物理清零。
- 同一用户或更高权限的恶意进程可检查进程或内存，不在该本地启动器的防护范围内。
- 加密 keystore 持久化；密码不持久化。密码遗失后无法恢复 faucet 与 validator 私钥。
- `Ctrl+C` 走现有优雅停机；所有者应等待子进程退出后再关闭终端。

## 验证

自动测试静态确认遮罩读取、SecureString/BSTR 释放、环境清理和无密码输出，并通过 dot-source 注入 SecureString 与动作，验证动作运行期间能读取密码、成功或抛错后环境消失、短密码在动作前被拒绝。测试不会向真实控制台索取密码，也不会初始化所有者的私人网络。

## 结果

首次初始化从多行秘密处理步骤缩减为一个可重复命令，K&M 可以安全地告诉所有者下一步而不请求秘密。它降低操作错误概率，但不替代密码管理器、离线 keystore 备份、七日真实使用证据或三设备验收。
