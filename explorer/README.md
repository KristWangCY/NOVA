# NOVA Explorer

NOVA Explorer 是 NOVA 私有链的本地区块浏览器。它直接读取默认节点 `http://127.0.0.1:4101`，展示链高度、quorum、供应量、最近区块、转账与文件存证，并支持搜索区块、交易、文件 SHA-256 和账户。选择本地文件时只在浏览器内计算哈希，不上传文件；浏览器验证上限为 64 MiB。

## 本地运行

在仓库根目录执行：

```powershell
npm.cmd run setup
npm.cmd run nova
```

然后打开 `http://127.0.0.1:3100`。3100 是 NOVA Explorer 的默认本地端口，避免与运行在 3000 的 K&M 协作平台冲突。如需单独启动界面：

```powershell
npm.cmd --prefix explorer run dev
```

## 验证

```powershell
npm.cmd --prefix explorer run build
npm.cmd --prefix explorer test
npm.cmd --prefix explorer audit --omit=dev
```

浏览器有意限制为本机节点。不要通过放宽 CORS 或让节点监听所有网络接口来实现远程访问；远程场景需要先建设 TLS、认证和只读网关。

生产依赖当前无已知审计漏洞。开发工具链中 vinext 的图片尺寸解析依赖仍有已知通告；本地文件验证不会把文件交给服务器或该图片解析依赖。详见根目录 `docs/adr/0003-local-explorer.md`。
