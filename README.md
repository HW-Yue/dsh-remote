# remote-client

## 控制机

控制机只需要启动注册中心：

```bash
git clone http://code.oppoer.me/S9064479/remote-client.git
cd remote-client
./scripts/start-registry.sh
```

如果远程机器需要通过局域网访问控制机，使用控制机局域网 IP 启动：

```bash
./scripts/start-registry.sh --host 0.0.0.0
```

启动后打开：

```text
http://127.0.0.1:32100/
```

## 添加远程机器

1. 在控制台点击“添加机器”。
2. 输入机器名称，中文和英文都可以。
3. 复制控制台生成的完整接入命令。
4. 在目标机器终端执行该命令。

机器身份会保存到：

```text
~/.dsh-remote/identity.json
```

该文件位于代码仓库之外。Agent、Executor 或代码更新重启后都会继续使用相同身份，因此机器名称、工作区和历史不会改变。

如果要限制这台机器可使用的目录范围：

```bash
DSH_EXECUTOR_ROOT=/workspace <控制台生成的接入命令>
```

脚本会自动完成依赖安装、项目构建和 agent 启动。远程机器需要 Node.js 22+ 和 pnpm/corepack。

## 日常操作

1. 控制机执行 `./scripts/start-registry.sh`。
2. 控制机浏览器打开 `http://127.0.0.1:32100/`。
3. 点击“添加机器”，填写名称并复制接入命令。
4. 在远程机器执行接入命令。
5. 机器显示在线后启动对应的 dsh Web。

不需要填写 token、绝对路径、JSON 配置或 executor 地址。

## 停止

在控制机或远程机器的终端按 `Ctrl-C` 即可停止对应进程。

## 网络

远程机器必须能访问控制机的 `32100` 端口。如果跨网络无法直连，使用局域网、VPN、Tailscale 或 ZeroTier。
