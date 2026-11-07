# VM QQ 最小运行准备

只使用官方 NapCat-Docker，不装 NapCat-Desktop，不新建 UI。工具本身不安装 Docker、不 pull、不启动容器、不读取账号。仅支持非 root 的 Linux arm64 VM；Node 使用现有 companion Node。

## 准备与启动（VM，操作人执行）

先由用户自己安装并验证 Docker：

```sh
sudo apt update
sudo apt install docker.io docker-compose-v2
docker --version
sudo docker compose version
sudo docker info >/dev/null
```

如发行版没有 `docker-compose-v2` 包，应先解决包源，不用未经核对的安装脚本。不要为了方便给模型进程挂 Docker socket 或自动加 docker 组（等价 root 权限）。

在项目根目录，以普通部署用户准备私有文件：

```sh
"$HOME/.local/opt/companion/bin/node" deploy/qq/prepare.mjs
```

生成 `~/.local/share/companion-world-v1/qq-runtime/`，目录 0700、初始文件 0600：

- `compose.yaml`：固定 `mlikiowa/napcat-docker:v4.18.42` 及 OCI index digest，`platform: linux/arm64`。
- `private/napcat.env`：独立随机 WebUI token，仅经官方 `WEBUI_TOKEN` 传入；另有 `MODE=ws`、当前部署用户 UID/GID。
- `private/onebot.token`：独立随机 OneBot token，供后续 QQ worker 在内存读取，不打印、不放命令参数、不挂给 Core。
- `data/config/onebot11.json`：官方 WS 模板的 token 加固版本，启动前已经鉴权。
- `data/qq`、`data/config`、`data/plugins`：唯一三处容器持久挂载，仅 QQ 登录、NapCat 配置和插件数据。没有 Core、模型 key、整个 HOME 或 Docker socket。

再次运行只确认已有准备，不覆盖配置、不轮换 token。中断后的不完整目录会拒绝，须操作人私下检查，工具不会自动删除、备份或修复。不要在源码目录生成 runtime。

**以下是后续显式启动步骤，本工具没有执行：**

```sh
cd "$HOME/.local/share/companion-world-v1/qq-runtime"
sudo docker compose -f compose.yaml config --quiet
sudo docker compose -f compose.yaml pull
sudo docker compose -f compose.yaml up -d
sudo docker compose -f compose.yaml ps --format json
curl -fsS -o /dev/null http://127.0.0.1:6099/webui/
```

仅发布 `127.0.0.1:6099:6099` 和 `127.0.0.1:3001:3001`；不使用 host 网络、privileged 或额外 capabilities。不要开放公网端口；宿主防火墙同样应拒绝外部 6099/3001，旧 Docker 的 localhost publish 不应当作唯一隔离措施。运行 NapCat 是运行第三方代码，不是对容器内插件的硬沙箱；不要安装未知插件。

## 登录（本机操作人）

```sh
node deploy/qq/open-login.mjs myvm
```

SSH 使用已有 `myvm` 别名。helper 只占本机 6099，不碰现有 3081/3082 隧道；端口已占用则拒绝。它通过 `ssh -t` 以 `sudo -u companion` 在内存读取 VM 实际 WebUI token（终端提示输入 sudo 密码），交给 macOS 默认浏览器（Linux 为 `xdg-open`），不输出含 token URL。用户在官方页面手动扫码；终端保持运行，Ctrl-C 只关闭这个 SSH 隧道。不要把登录页 URL、二维码、账号或私有配置贴进会话。浏览器历史/本机进程参数仍可能留有 token URL，操作人应把本机浏览器视为可信入口。

首次 QQ 登录后，上游 `ConfigBase` 会从 `onebot11.json` 继承并生成账号命名配置，保留随机 WS token，**不用手填 QQid，不存在先开无鉴权 WS 再补 token 的窗口**。默认未指定 `ACCOUNT`，由用户选择扫码。若以后 WebUI 修改 OneBot token，须操作人同步 worker 的 `private/onebot.token`；不要重跑准备工具期望覆盖已有账号配置。当前 helper 要求 WebUI token 仍为生成的 64 位 hex、端口及 prefix 未改。

官方 `MODE=ws` 只复制模板，**不会读取 `TOKEN` / `ONEBOT_TOKEN` 来替换空 token**。所以先生成加固模板，entrypoint 因配置已存在而保留它；WebUI token 则使用成熟 entrypoint 的 `WEBUI_TOKEN` 初始化逻辑。

安全日志：上游 WebUI 启动代码会打印 token 和带 token URL，QQ 日志也可能含私人内容；compose 设置 `logging.driver: none`，不持久化 Docker stdout。不要 `docker logs`、不要输出不带 `--quiet` 的 `docker compose config` 或 `docker inspect`（会展开 env）。内部 QQ/NapCat 文件仍属私有运行数据，不承诺第三方永不记录。

## 官方核对（2026-11-01，仅 HTTP 元数据，未拉镜像）

- [稳定 release v4.18.42](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.42)：非 prerelease。
- [Docker Hub release tag](https://hub.docker.com/v2/repositories/mlikiowa/napcat-docker/tags/v4.18.42)：active linux/arm64，597,540,043 B；OCI index digest 已固定到 compose。
- [Docker 官方入口](https://github.com/NapNeko/NapCat-Docker/blob/76f3e6639c93ddd2914022f4387f03df9335518f/entrypoint.sh)、[WS 模板](https://github.com/NapNeko/NapCat-Docker/blob/76f3e6639c93ddd2914022f4387f03df9335518f/templates/templates/ws.json)：初始化 env 与路径。
- [v4.18.42 配置继承](https://github.com/NapNeko/NapCatQQ/blob/v4.18.42/packages/napcat-core/helper/config-base.ts)、[OneBot WS schema](https://github.com/NapNeko/NapCatQQ/blob/v4.18.42/packages/napcat-onebot/config/config.ts)、[WebUI token 与启动日志](https://github.com/NapNeko/NapCatQQ/blob/v4.18.42/packages/napcat-webui-backend/index.ts)。

本地仅纯内容测试，不生成真实 token 或运行目录：

```sh
node --test deploy/qq/prepare.test.mjs
```

上述初始内容检查不冒充真实运行验收。后续已在 VM 实际拉取、启动并由用户扫码，QQ 私聊和暂停边界通过；绑定、授权及 Authority 生命周期仍由产品管理面负责。

## 开机恢复（0.7.1）

首次绑定、登录成功且世界处于维护暂停后，在 VM 运行：

```sh
~/.local/opt/companion/bin/node ~/src/dsh-companion/authority-0.7.1/deploy/qq/configure-recovery.mjs
```

它仅从已批准的私有设置读取账号，不输出值；保留原 token 和数据卷，配置 Docker ACCOUNT 以及官方 WebUI autoLoginAccount、启用本用户 Linger 与现有用户服务，并保存只含验证元数据的基线。环境改变时 compose up 可能重建容器，不能保证旧登录态仍有效；遇过期只提示用户正常扫码，不无限重试或修改设备信息。

QQ 服务等待 SDK HTTP 与产品插件真正就绪；WebSocket 已连接但 QQ 慢登录时定期串行查询身份，断线迟到结果无效。不开新 supervisor，不补发旧消息，不自动恢复世界生活。

```sh
# 当前状态，只读，不发送模型/聊天请求
~/.local/opt/companion/bin/node ~/src/dsh-companion/authority-0.7.1/deploy/qq/verify-recovery.mjs
# 用户确认并执行完整 VM 重启后；须保留重启前的验证基线
~/.local/opt/companion/bin/node ~/src/dsh-companion/authority-0.7.1/deploy/qq/verify-recovery.mjs --new-boot
```

不要在重启验收前再次运行配置命令覆盖基线。当前已实测同容器 restart 与完整 VM 重启免再次扫码，后台在首次 SSH 检查前启动；世界仍暂停、数据与绑定保留。不能保证 QQ 凭据永久有效或任何容器重建都免扫，详见[实测与限制](<../../notes/boot-recovery-live-20261101.md>)。
