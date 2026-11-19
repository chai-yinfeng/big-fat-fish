# 房间（room v0）

一个网页：伪 2.5D 的房间，她在里面做自己的事。房间只是看 Authority 世界状态的一扇窗，
**自己不决定任何事**：它拿到一份“房间状态”，按素材清单把它画出来。

这条链路是：房间状态契约 → 分层渲染。画是占位的手画 SVG；数据默认是假的，也可以读 Authority 的只读出口
（见“真实数据”）。发行包里带着它和一个用户单元 `companion-room.service`（真实模式，只听回环，经 tailscale serve
只在 tailnet 内访问），见最后一节“部署”。

```sh
node room/serve.mjs          # 只听 127.0.0.1:4173，本机预览；默认假数据
# http://127.0.0.1:4173/                      假时间线，每 6 秒一步，走完所有活动
# http://127.0.0.1:4173/?step=2000            每 2 秒一步
# http://127.0.0.1:4173/?activity=sleeping    固定在某个活动
node --run test:room
```

假数据模式下，页面下方的“假数据”一栏可以强制活动、天气、时段。纯静态文件，没有构建步骤，没有依赖
（`console/` 因为用 React 才需要 esbuild；这里用不着）。

| 文件 | 作用 |
|---|---|
| `state.js` | 房间状态契约、校验、构造 |
| `providers/fake.js` | 假数据：每个活动一份固定状态，加一条走完一天的时间线（只由时刻决定，可重复） |
| `providers/authority.js` | 真实数据：向页面自己的服务器要 `state`，按契约再校验一遍（映射本身在 `authority/src/room.js`） |
| `manifest.json`、`manifest.js` | 素材清单及其校验 |
| `view.js` | 页面上的文字（按类别选固定句子） |
| `index.html`、`room.js`、`room.css` | 页面 |
| `assets/` | 占位画（自己画的 SVG，不含第三方素材） |
| `serve.mjs` | 页面的静态服务（本机预览，也是发行包里房间单元跑的东西）；真实模式下替页面去读 Authority 的 `GET /v1/room` |

## 房间状态（v1）

```js
{
  version: 1,
  source: 'fake' | 'authority',
  at: 1794990000000,            // 这份状态是哪一刻的（毫秒）
  since: 1794989400000,         // 当前活动从哪一刻开始（≤ at）
  clock: { timezone: 'Asia/Shanghai', minute: 0..1439, phase: 'dawn' | 'day' | 'dusk' | 'night' },
  weather: 'clear' | 'cloudy' | 'rain' | 'snow',     // 真实数据里固定是 clear（还没有来源）
  lamp: 'on' | 'off',
  activity: 'idle' | 'replying' | 'speaking' | 'watching' | 'writing' | 'working' | 'sleeping',
  pose: 'sitting' | 'phone' | 'mic' | 'screen' | 'notebook' | 'laptop' | 'bed',
  mood: 'calm' | 'cheerful' | 'tired'                // 可选，很粗；真实数据里没有
}
```

| activity | 含义 | 默认 pose |
|---|---|---|
| `idle` | 发呆 | `sitting` |
| `replying` | 在看手机（刚有会话动过；可能在回，也可能只是在刷，页面不说是哪种） | `phone` |
| `speaking` | 在说话（语音） | `mic` |
| `watching` | 在看视频 | `screen` |
| `writing` | 在写日记 | `notebook` |
| `working` | 后台在忙一件事（沙箱、后台任务） | `laptop` |
| `sleeping` | 睡了（安静时段） | `bed` |

`phase` 由 `minute` 决定：05:00 清晨、07:30 白天、17:30 傍晚、19:30 夜里。没给 `lamp` 时，
傍晚和夜里她醒着就开灯。一个活动以后可以有多个 pose（`POSES` 里每个活动是一个列表）。

### 隔离（硬规则）

同一个房间可能有好几个人在看，所以它只显示她在做的事的**类别**，不显示：在和谁聊、
消息内容、谁分享的视频、日记正文、任务内容。这条规则写在契约里，不靠页面自觉：

- 状态里没有放这些东西的字段；`validateRoomState` 拒绝任何未列出的字段。
- 状态里每个字符串都来自固定的词表，没有自由文本，所以也塞不进已有字段。
- `roomState()` 只读契约自己的字段，输入里多出来的东西直接丢掉，不复制。
- 页面文字（`view.js`）是按类别选的固定句子，时长只说到“已经 12 分钟”这个粒度。

`room.test.mjs` 用带着人名、QQ 号、消息、任务标题和结果的输入检查这几条。

仍然会透露的：活动类别和它的大致时长本身（例如“她刚拿起手机”说明此刻多半有人在找她）。
这是“在场感”的代价，是否接受由主人决定。

## 素材清单：换成真图或循环视频

换画 = 把文件放进 `assets/`，改 `manifest.json`，不改代码。坐标都是舞台单位
（`stage.width × stage.height`，原点在左上角），页面按比例缩放。

```json
{
  "version": 1,
  "stage": { "width": 1600, "height": 1000 },
  "base": { "src": "assets/base.svg" },
  "window": [[740, 100], [520, 210], [520, 350], [740, 240]],
  "lamp": { "x": 1390, "y": 455, "radius": 420 },
  "poses": {
    "sitting": { "kind": "image", "src": "assets/pose-sitting.svg", "anchor": { "x": 740, "y": 705 }, "width": 180 },
    "bed": { "kind": "video", "src": "assets/sleep-loop.webm", "poster": "assets/sleep.png", "anchor": { "x": 460, "y": 760 }, "width": 520 }
  },
  "hotspots": [{ "id": "window", "shows": "weather", "polygon": [[740, 100], [520, 210], [520, 350], [740, 240]] }]
}
```

- `base`：底图，铺满舞台。图片比例要和 `stage` 一致。
- `poses`：七个 pose 都要有。`kind` 是 `image`（svg/png/jpg/webp/avif/gif）或 `video`（webm/mp4，
  静音、循环、自动播放；`poster` 可选）。`anchor` 是这张图**底边中点**（她的脚）落在舞台上的位置，
  `width` 是图在舞台上的宽度，高度按图自己的比例。人物图要透明背景；视频要透明的话用带
  alpha 的 WebM（VP9），mp4 没有透明通道。
- `window`（可选）：窗户的多边形，天空和天气画在里面。真图自己画了窗外就删掉这一项。
- `lamp`（可选）：灯光晕的中心和半径。
- `hotspots`：可点的区域，`shows` 只能是 `activity`、`weather`、`clock`、`lamp`，点开的小抽屉
  只显示类别级的信息。她本人也可以点（显示 `activity`）。
- 文件只能是页面旁边的相对路径；`manifest.js` 拒绝网址、`..` 和别的文件类型。

注意：仓库的 `.gitignore` 忽略 `*.mp4`、`*.mov`，mp4 不会进 Git；真素材放不放进这个公开
仓库由主人决定。

分层从下到上：底图 → 窗外（天空、天气）→ pose → 光照（按时段整体着色）→ 灯光晕 → 热区 → 抽屉。

## 真实数据

房间状态由 Authority 自己在进程内算（`authority/src/room.js`），从它的 capability socket 上的只读出口
`GET /v1/room` 给出，返回的就是上面这份契约，别的什么都没有（协议见 `authority/PROTOCOL.md` 的 Room 一节）。

```
浏览器 ──GET /state──▶ room/serve.mjs（真实模式，只听 127.0.0.1）──GET /v1/room + room 凭据──▶ Authority（Unix socket）
```

- **凭据**：一条 `role: 'room'` 的授权（令牌的 sha256）。部署时它在 Authority 配置旁边单独的
  `room-credential.json` 里（见“部署”；测试里也可以直接写进 `credentials`）。这个角色只能
  `GET /v1/room`：别的路由、别的方法一律 403（包括 health 和任何写入）；它也不是 operator 令牌，operator
  socket 不认它。反过来，渠道、记忆 worker、admin 的凭据读不了 `/v1/room`。
- **serve.mjs 真实模式**：给出 Authority 的 socket 和凭据文件（都是绝对路径；凭据文件只能自己可读，如 0600）。

  ```sh
  node room/serve.mjs 4173 --authority-socket /abs/authority.sock --credential-file /abs/room.token
  # 或者用环境变量 ROOM_AUTHORITY_SOCKET、ROOM_CREDENTIAL_FILE
  ```

  页面每 5 秒问一次自己的服务器 `GET /state`；服务器把结果缓存 5 秒，所以看的人多不会让 Authority 多读。
  凭据只留在 serve.mjs 进程里，只发给那个 Unix socket；它回给浏览器的任何东西里都没有凭据，凭据文件也
  不在它能提供的目录里。读不到时 `/state` 回 503 和空对象（不带原因），页面保留上一幅画并提示稍后再试。
  真实模式下页面不显示“假数据”一栏；`?fake=1` 强制看假数据，`?fake=0` 在没有真实数据时报错而不是退回假数据。
- 两头都按契约校验：serve.mjs 收到的、页面收到的状态都再过一遍 `validateRoomState`，多一个字段就拒绝。

规则，按先后：

1. 世界没暂停，且最近 90 秒内有新消息（任一会话、任一方向）→ `replying`，pose 是 `phone`（夜里也是：有人
   找她就醒）。页面说的是“看手机”，不说她在回谁：这个信号分不清“她正在回”“她刚回完”和“别人刚发来”。
2. 在安静时段（控制台设过就用设的，否则默认 23:30–08:00）→ `sleeping`，从安静时段开始的那一刻算起。
3. 世界没暂停，且内容服务有后台任务在跑 → `working`，从最早开始的那个算起。内容服务连不上就当没有。
4. 其余 → `idle`，从最近一条消息算起。

`weather` 固定是 `clear`，没有 `mood`：两者都还没有来源。人、标签、会话、消息、任务标题和结果一概不读。

这个出口只读：不调用 `initiationLog()`（它读的时候会顺手结清过期的发起请求，有写入），只用纯函数
`quietHours()` 和已存的安静时段设置；不写数据库、不记审计，可以轮询。“最近的消息时间”只看最新到达的
64 条 observation，读取量不随历史增长。没有改数据库结构，没有数据迁移。

还没有的信号：

1. `replying` 只是近似（见上）。要准确，需要渠道桥或执行器报告“回合进行中”。
2. `speaking`（语音合成/发送中）、`watching`（看视频）、`writing`（写日记）没有任何可读的信号：语音在内容
   服务里同步完成，不留“进行中”；看视频的能力还不存在；日记由记忆 worker 定时写，Authority 不知道它正在写。
   需要这些能力各自报告一个只有类别的“开始/结束”，由 Authority 汇总。真实模式下这三种活动不会出现。
3. `weather`、`mood` 没有来源。

## 部署（方案 A：companion 账号下的一个用户单元，只在 tailnet 内访问）

发行包里有 `room/`（页面、占位画、`serve.mjs`）、单元 `companion-room.service` 和一次性准备脚本
`ops/prepare-room.mjs`。和其他服务一样跑在 `companion` 账号的 systemd user manager 下，由 `companion-deploy`
安装、启动、做健康检查、回退。

```
手机/电脑（tailnet 内）──HTTPS──▶ tailscale serve（主人配置）──▶ 127.0.0.1:4173 companion-room.service
                                                              └─ GET /v1/room + room 凭据 ─▶ Authority（Unix socket）
```

- **单元**：`node current/room/serve.mjs 4173 --authority-socket <数据根>/ipc/authority/authority.sock
  --credential-file <数据根>/room-config/room.token`，在 Authority 之后启动，只听 `127.0.0.1:4173`；
  seccomp 把网络限制在 Unix socket 和 IPv4。它手里只有 room 凭据：没有 operator 令牌、渠道凭据和供应商 Key，
  不在模型 worker（对话执行器）的配置里。
- **凭据**（`ops/prepare-room.mjs`，主人以 companion 身份跑一次，可重复跑，不重置任何东西）：
  - `<数据根>/room-config/room.token`：令牌，0600（目录 0700），只有 serve.mjs 读；
  - `<数据根>/operator/room-credential.json`：`{ "schemaVersion": 1, "hash": "<令牌的 sha256>" }`，0600。
    Authority 启动时从配置文件旁边读它（沙箱里是 `/authority/room-credential.json`，`launch.py` 在文件存在时只读挂进去）。
  - **不写进 `authority.json`**。有房间之前的 Authority 见到 `credentials` 里的 `role: 'room'` 会拒绝启动；单独的文件
    旧版本根本不读，所以 `companion-deploy rollback`（以及健康检查失败后的自动恢复）不需要先改配置。预检遇到写在
    `authority.json` 里的 room 凭据会以 `ROOM_CREDENTIAL_INLINE` 拒绝部署。
  - 轮换：`deploy/authority/rotate-tokens.mjs` 把它和其他内部凭据一起换。
- **还没准备凭据时**（已有的世界第一次升级到带房间的版本）：单元照常启动、页面能打开，`/state` 回 503，页面提示
  稍后再试。跑完 `prepare-room.mjs` 并重启服务后就有真实数据。
- **预检**（`ops/preflight.mjs`）：room 凭据两个文件要么都没有，要么成对且一致（0600、属主、格式、令牌的 sha256 等于
  登记的哈希、不与 `authority.json` 里的凭据重复）；新包里有 `room/serve.mjs`、素材清单合法、清单里的文件都在。
  错误码：`ROOM_CREDENTIAL_INLINE`、`ROOM_CREDENTIAL_MISSING`、`ROOM_TOKEN_MISSING`、`ROOM_TOKEN_MISMATCH`、
  `ROOM_CREDENTIAL_DUPLICATE`、`ROOM_FILES_MISSING`、`ROOM_ASSET_MISSING`、`ROOM_MANIFEST_INVALID`。
- **健康检查**：`companion-room.service` 是带 `[Install]` 的单元，`companion-deploy` 的健康检查要求它 active 且观察窗口内
  没有重启（端口被占等启动失败会让它退出重启，部署随之失败并自动恢复上一版）。`companion-deploy` 本身没有改，
  不需要重装；它的端口检查仍只有 3082（把 4173 加进去会让回退到没有房间的旧版本失败）。

### 主人上线时要做的（按顺序；Agent 不执行 sudo）

```sh
# 1. 照常部署（见 docs/DEV_WORKFLOW.md“发布与回退”）。完成后房间单元已在跑，/state 是 503。
ssh -t home-agent 'sudo companion-deploy deploy ~blackmagic/releases/<release>.tar.gz'
# 2. 生成 room 凭据（一次；输出只有 JSON 摘要，不含令牌）
ssh -t home-agent "sudo -u companion -H bash -c 'cd ~ && ~/.local/opt/companion/bin/node ~/src/companion/current/ops/prepare-room.mjs'"
# 3. 重启服务让 Authority 读到它（带健康检查）
ssh -t home-agent 'sudo companion-deploy start'
# 4. 只在 tailnet 内开放（一次；--bg 的配置由 tailscaled 保存，重启后仍在）。
#    home-agent 的 443 已经有别的 tailscale serve 在用，所以房间用 8443：
ssh -t home-agent 'sudo tailscale serve --bg --https=8443 http://127.0.0.1:4173'
ssh home-agent 'tailscale serve status'        # 应多出一行 :8443 → http://127.0.0.1:4173，且标着 tailnet only
# 5. 用 tailnet 里的手机或电脑打开 https://<home-agent 的 MagicDNS 名>:8443/
```

- 不要用 `tailscale funnel`（那是公网）。能看到房间的人 = tailnet 里按 ACL 能访问 home-agent 这个端口的设备；
  页面本身没有登录。要收回：`sudo tailscale serve --https=8443 off`。
- 第 4 步没有在主机上验证过（Agent 不能 sudo）：语法取自该主机 tailscale 1.104 的 `serve --help` 和现有的 serve 配置。
- 无 sudo 的核查：`ssh home-agent "ss -Hltn | grep ':4173 '"` 应只有 `127.0.0.1:4173`；
  `ssh home-agent 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4173/state'` 第 1 步后是 503，第 3 步后是 200。

### 回退

- `sudo companion-deploy rollback` 回到没有房间的版本：旧的单元快照里没有 `companion-room.service`，它被停掉并删除，
  4173 不再监听；`room-config/room.token` 和 `operator/room-credential.json` 原样留在数据根，旧 Authority 不读它们，
  正常启动。**不需要任何手工步骤。** tailscale serve 的 8443 留着也无妨（后端不在，打开是 502）。
- 再升级（或再 rollback 一次回到新版本）：凭据还在，房间直接恢复，不用重跑 prepare。
- staging 每次都走一遍：升级后未准备（503）→ prepare → 重启 → 用 room 凭据读到状态、其他路由 403、别的凭据读
  `/v1/room` 403 → 回退（无房间单元、旧 Authority 带着凭据文件健康启动）→ 前滚（房间恢复）→ manager 重启后再查一次。

### 还没做 / 等主人决定

1. **真素材**：仍是仓库里的占位 SVG。素材清单目前只能指向发行包里 `room/` 下的文件，还不支持从数据根覆盖；
   真图放哪里（不进公开仓库）要另做。
2. **在场感透露多少**：房间会让所有看的人知道“刚刚有人找过她”（看手机）和她的安静时段。是否要更模糊由主人决定。
3. **tailnet 之外**：没有登录、没有每人一个链接；现在不开公网。
4. 用真手机经 tailnet 看页面还没做过。
