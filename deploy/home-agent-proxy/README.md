# home-agent 下载代理（Mihomo）

home-agent（中国大陆）上只供公共软件与依赖下载的用户级代理，监听 `127.0.0.1:7890`
（AGENTS.md“home-agent 网络先走本机代理”指的就是它）。跑在用户 `blackmagic` 下，不是
companion 账号，与 big-fat-fish 生产服务无关；不需要 sudo。

**来源**：2026-11-24 从已归档的 home-agent-ops 仓库 `proxy/` 迁入（manage.py、测试、安装脚本、
三个 systemd 单元），此后只在这里维护；归档仓库不再修改，诊断记录留在那边的 `proxy/notes/`。

## 文件

| 本目录 | 用途 |
| --- | --- |
| `manage.py` | helper：`update` / `status` / `diagnose` / `run`，安装为 release 里的 `helper.py` |
| `test_manage.py` | 离线回归（全部虚构数据）；需要 PyYAML |
| `install-runtime.sh` | 在 home-agent 上安装一个新 release 并切换，失败自动切回 |
| `systemd/` | 代理服务、订阅更新服务、12 小时 timer |

| home-agent 上 | 用途 |
| --- | --- |
| `~/.config/home-agent-proxy/subscription-url` | 订阅 URL，单行 `0600`，不能展示或进 Git |
| `~/.config/home-agent-proxy/config.json`、`config.previous.json` | helper 生成的私密配置及上一份 |
| `~/.local/lib/home-agent-proxy/releases/<release>/` | `mihomo`、`helper.py`、`SHA256SUMS`；旧 release 保留不删 |
| `~/.local/bin/home-agent-proxy` | 指向当前 release 的 `helper.py` |
| `~/.local/state/home-agent-proxy/` | `status.json`、更新锁、`core/`、`recovery/`（旧单元备份） |
| `~/.config/systemd/user/home-agent-proxy*` | 三个单元，`ExecStart` 写死当前 release 路径 |

release 名是 Mihomo 版本加 helper 修订（`manage.py` 的 `RELEASE`，现为 `v1.19.33-2`）；
改 helper 就把修订号加一，同时改 `systemd/` 里的路径，安装脚本会核对两者一致。
`v1.19.33` 是迁入前的旧 release。

Mihomo 固定 `v1.19.33`（源码 commit `3f27ef39f8c96bbfbc8b0b9bb10f5c9ef60149d8`）：官方资产
`mihomo-linux-amd64-compatible-v1.19.33.gz` SHA-256 `386508bf…c622b6`，解压后程序
`817f50b3…2b620f`（全值写在 `install-runtime.sh`）。helper 用系统 `/usr/bin/python3` 与系统 PyYAML。

## 安全边界

- 只监听 `127.0.0.1:7890`；没有 LAN 监听、TUN、DNS 监听、面板或控制接口。
- 订阅里只投影 AnyTLS/Hysteria2 内联节点的审核过字段，节点改名为 `node-NNN`；监听、规则、
  provider、脚本等顶层配置一律不加载，格式变化拒绝更新。
- 先拒绝 loopback、私网、链路本地、tailnet 目的地，再只放行 `docker.io`、`docker.com`、
  `cloudflarestorage.com`、`github.com`、`githubusercontent.com`、`npmjs.org`、`pypi.org`、
  `pythonhosted.org`、`nodejs.org`，其余 `MATCH,REJECT`，不回退 DIRECT。
- 节点的 `skip-cert-verify` 按订阅（主人接受），只影响节点这一层；目标网站 HTTPS 照常校验。
- 输出（status/diagnose/journal）只有固定错误码、检查名和计数，不出现订阅、节点名、地址、端口、
  密码、SNI 或 DNS 服务器。私密目录 `0700`、文件 `0600`，读写不跟随 symlink，配置原子替换。

### 节点域名的解析（2026-11-24 修复）

机场节点的 server 是域名，只有机场自己的加密 DNS（订阅 `dns.nameserver-policy`）给出可达地址，
系统/公共 DNS 返回的地址连不上；旧 helper 不带这段，导致节点全部超时。主人接受依赖机场 DNS。

现在 `update` 从订阅读 `dns.nameserver-policy`，只保留：

- key 是 `+.x`、`*.x` 或 `x`（逗号分隔的多个也拆开），且至少覆盖一个节点 server 域名；
  其余 key（`geosite:`、`rule-set:`、无关域名）忽略；
- value 只留 `tls://` 或 `https://`（IP 或域名，可带端口；https 可带路径），不允许凭据、query、
  `#` 参数，不允许私网/回环地址和 `.local` 等内部名字；
- 上限：16 个 key，每个 key 8 个服务器。

生成配置用 `dns.proxy-server-nameserver-policy`：这些服务器**只用于解析节点域名**；其余解析
（`nameserver`、`default-nameserver`、`proxy-server-nameserver`）都是 `system://`，`enhanced-mode: normal`，
不设 `listen`，因此不开 DNS 端口，目的地解析仍走系统 DNS。订阅没有相关 policy 时生成
`dns: {enable: false}`，与以前完全相同。错误码：形状不对或超上限 `dns_policy_invalid`；
覆盖节点的 key 一个可用的加密服务器都没有 `dns_policy_unsupported`（拒绝更新，保留现配置）。

## 测试

```sh
node --run test:deploy        # 含 python3 -m unittest discover -s deploy/home-agent-proxy
```

Mac 的 python3 没有 PyYAML 时这一组整体 skip（会显示 skipped）。完整跑：

```sh
uv run --no-project --with pyyaml python -B -m unittest discover -s deploy/home-agent-proxy -p 'test_*.py'
```

或拷到 home-agent 的临时目录用系统 python3 跑（那里还会跑 Linux O_PATH 那一项）。

## 安装 / 升级（home-agent，用户 blackmagic，不用 sudo）

把本目录拷到 home-agent 的临时目录（只需 `manage.py`、`install-runtime.sh`、`systemd/`），然后：

```sh
# 用官方 gzip 资产，或直接用已装 release 里核对过的程序（两者 SHA-256 都会核对）
bash install-runtime.sh ~/.local/lib/home-agent-proxy/releases/v1.19.33/mihomo --yes
```

脚本：核对程序 → 建新 release 目录（已存在且内容不同就拒绝）→ 把当前三个单元和入口指向备份到
`~/.local/state/home-agent-proxy/recovery/<时间>-units/` → 换单元、换入口 → `update` → 重启服务 →
经代理取 Docker registry 必须得到 401 → 启用 timer。`update` 或复验失败就自动换回备份的单元和入口、
重启旧服务，并打印 `proxy_rolled_back=true`。首次安装需要用户 linger 已开启。

## 日常

```sh
~/.local/bin/home-agent-proxy status
~/.local/bin/home-agent-proxy diagnose
systemctl --user start home-agent-proxy-update.service   # 手动重放一次更新
~/.local/bin/home-agent-proxy run -- curl -I https://registry.npmjs.org/
curl -sS -o /dev/null -w '%{http_code}\n' -x http://127.0.0.1:7890 https://github.com
```

- **update**（timer 每 12 小时，带随机延迟）：直连订阅、校验 HTTPS、限大小与时间、拒绝重定向 →
  投影 → Mihomo `-t` 校验 → 与现配置**字节相同就不提交不重启**，只在服务运行时复验一次 →
  否则保存上一份、原子替换、重启、经代理复验，失败恢复文件和服务。
  状态码：恢复本身失败才是 `rollback_failed`；恢复成功但上游仍不可达是 `upstream_verification_failed`。
  失败时 journal 里打印的就是写进 `status.json` 的那份（含 checks 与节点数）。
- **status**：`ready` 只表示服务 active、状态可读，不做网络测速。
- **diagnose**：读当前配置，只输出计数——节点数、TCP 节点端点数、域名数、policy 数、两种解析
  （`system` 与 `provider_dns`）下的 resolved/unresolved 与 TCP connect 成功/超时/失败数、
  两种解析答案不同的域名数、经代理访问 registry 是否成功。不写状态、不改配置，绝不输出地址。
- **run --**：只给子命令设代理环境（含内网 NO_PROXY），不改当前 shell；SSH 形式的 git remote 不会被代理。

Docker daemon 的代理是独立配置，本工具不改它。

## 回滚

安装脚本失败会自动回滚。事后要手动切回旧 release（例：旧的是 `v1.19.33`）：

```sh
b=~/.local/state/home-agent-proxy/recovery/<时间>-units      # 安装时的备份
systemctl --user stop home-agent-proxy-update.timer
cp "$b"/home-agent-proxy*.service "$b"/home-agent-proxy-update.timer ~/.config/systemd/user/
ln -sfn "$(cat "$b/previous-entry")" ~/.local/bin/home-agent-proxy
systemctl --user daemon-reload
systemctl --user restart home-agent-proxy.service
systemctl --user start home-agent-proxy-update.timer
```

旧 helper 能运行新 helper 写的 `config.json`（同一个 Mihomo）。但新 helper 的 `status.json`
可能含旧 helper 不认识的错误码（`dns_policy_*`），旧 helper 会报 `state_invalid` 并拒绝更新；
这时先把这个只含计数的状态文件挪开（`mv ~/.local/state/home-agent-proxy/status.json{,.new-helper}`）。
完全停用：`systemctl --user disable --now home-agent-proxy-update.timer home-agent-proxy.service`
（配置和订阅保留）。

## 维护

改 Mihomo 版本、订阅字段、TLS 策略、DNS 投影或放行域名时，重读对应版本的官方源码/文档
（[release](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33)、
[DNS 配置](https://wiki.metacubex.one/en/config/dns/)、[通用配置](https://wiki.metacubex.one/en/config/general/)），
重新核对资产哈希，跑测试，并在 home-agent 上先用临时实例（临时目录、未占用的回环端口）验证再安装。
