# ADR 0017：隔离 K&M 与 NOVA Explorer 的本地端口

- 状态：接受
- 日期：2026-08-11

## 背景

K&M AI Administration 作为 NOVA 的协作平台运行在 `localhost:3000`。NOVA combined launcher 过去让 vinext 使用同一个默认端口。所有者第一次执行 `npm.cmd run nova:secure` 时，Explorer 会绑定失败；启动器随后可能停止刚启动的私链。这会让 v0.16 的正确初始化引导在真实环境中仍不可执行。

## 决策

NOVA Explorer 的默认地址改为 `http://127.0.0.1:3100`，combined launcher 和 Explorer standalone script 保持一致。K&M 继续使用 3000，默认节点 API 继续使用 4101–4103。

combined launcher 读取可选 `NOVA_EXPLORER_PORT`，只接受 1024–65535 的十进制整数，并拒绝 4101、4102、4103。host 固定为 `127.0.0.1`，不能用环境变量改为外部接口。启动任何节点或 Explorer 子进程前，launcher 用一次临时 exclusive TCP listener 检查所选端口；占用时明确报告地址和覆盖变量，然后零子进程退出。

## 安全与限制

- 更换端口不改变本地只读 Explorer 的安全边界，也不批准公网访问。
- 节点现有 CORS 规则允许 `localhost` 与 `127.0.0.1` 的任意本地端口，因此 3100 不需要放宽来源范围。
- 端口探测和 vinext 最终 bind 之间存在很短的 TOCTOU 窗口；真正绑定失败时仍由启动器的 child exit 处理，不把探测描述为锁。
- 4101–4103 黑名单与当前 fixed local launcher 拓扑绑定；若未来节点端口可配置，必须从同一运行配置派生保留集合。

## 结果

K&M 和 NOVA 可以在同一台 Windows 电脑同时运行，首次初始化不再因 3000 冲突失败。代价是旧的 3000 书签需要改为 3100，任何调用者若覆盖端口都必须处理新的严格校验。
