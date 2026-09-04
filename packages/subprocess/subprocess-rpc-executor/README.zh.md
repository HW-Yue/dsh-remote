# @deepseek-ai/dsh-subprocess-rpc-executor

[English](README.md) | 中文

远程 subprocess 和文件系统 Provider 使用的轻量本地 executor。它为一个已认证 RPC 对端持有本地进程句柄与文件系统操作。`--root` 只控制目录浏览以及可被采纳为 Session 工作区的目录范围，不会把所有 Session 永久绑定到一个工作区。

使用可选浏览根目录、host 和 port 运行构建后的二进制。根目录默认为 `/`；如果目录选择器不应暴露整个服务器/容器文件系统，可以指定更窄的根目录。可选概念验证 token 应通过 `DSH_EXECUTOR_TOKEN` 提供，而不是作为参数：

```bash
DSH_EXECUTOR_TOKEN=local-poc-token \
dsh-subprocess-executor --root / --host 127.0.0.1 --port 3210
```

executor 不运行 Agent、不加载 preset，也不接收 LLM API key。目录浏览和工作区采纳始终限制在配置的根目录内。`workspace-write` 请求限制在已采纳的 Session 工作区；`danger-full-access` 请求可以访问 `/` 及其子路径，但仍受 executor 进程操作系统权限限制。连接关闭会终止并等待该连接所属的进程。

## 模型体验

无，因为 executor 为服务器侧 Consumer 执行获准的效果，并且不注册面向模型的表面。

#### KV Cache 影响

无。executor 不贡献 prompt 文本、工具 schema 或模型请求字段。

## 已知限制与暂缓事项

- **一个活动执行世界** —— 支持一条连接和一张进程表；连接可以持有多个已采纳的 Session 工作区，重连、租约代际、executor 切换和多 executor 均暂缓。
- **没有 PTY** —— executor 拒绝终端会话，而不会用普通管道模拟。
- **收集输出通过轮询发布且有界** —— 本地收集输出读取器是同步接口，因此 executor 按配置周期发送增量；超过保留上限后可能有意丢失。
- **只有概念验证认证** —— 可选静态 token 仅适用于 localhost 或可信私网；没有生产传输身份与授权时，不得把监听器公开暴露。
- **没有内核级进程沙箱** —— 工作区检查限制文件系统 RPC 和 subprocess cwd，但获准的进程仍保留本地操作系统账号的环境权限。
