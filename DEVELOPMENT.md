# 大肥鱼：开发与部署

## 权威与工作方式

VM 是唯一正式运行数据源，只用于生产；开发、Git和构建只在 Mac。运行数据、凭据、权重、缓存、二维码和构建目录不进入Git。

```text
Mac编辑 → 相关检查 → 提交并合入main → stage-release → 用户 sudo companion-deploy → 实际验证
```

对外仍为 @local/companion 一个产品，内部服务不分别成为角色插件。已获确认的旧包卸载/旧运行数据清理不代表本轮重新启用历史语音supervisor。不要复制Mac旧Key或登录态。

最终世界控制台独立于DSH Web；当前设置页只是过渡入口。Live2D/房间视觉不在本轮。见[运行权威与最终UI](<notes/world-ui-and-runtime-boundary.md>)与[当前架构](<ARCHITECTURE.md>)。

## 当前模块

```text
authority/                  唯一世界、实体、身份、人格、记忆与规则
capabilities/conversation/  状态端口与纯文本执行契约
integrations/dsh/           可替换DSH执行及RPC适配
capabilities/dsh/           来源/turn/epoch验证与受限工具
capabilities/qq/            认证入站、平台文件转换、逐项发送回执
capabilities/media/         scoped素材、派生感知、表达与清理
capabilities/speech/        轻重ASR/TTS本地文件后端
capabilities/memory/        增量日记维护与明确遗忘清理
model-gateway/              私有Key、固定DeepSeek出口与预算
console/                    过渡管理界面，不是第二套脑
deploy/                     完整构建、准备、安装与显式验收
```

旧plugin/ui/preset等不随新产品发布。Authority没有DSH/Cordis/QQ SDK依赖；QQBridge注入执行器。默认仍选DSH，自有Agent/tool loop使用pi-ai模型适配，不把pi-ai说成整个coding agent，也没有手写新的LLM循环。

模型worker只有companion_scope、companion_content两个受限工具，无系统、任意文件或通用网络执行。content只提供公网search/read和scoped媒体，模型不选entity/QQ号/路径/epoch/requestId。看不到DB、operator/control sockets、真实供应商Key、NapCat token、登录卷或Docker socket。QQ source.kind=user标签本身不证明QQ身份，必须匹配真实只读inbox关联。

QQ只取匹配requestId的最终回合，不外发思考或中间工具结果。生成音频/排入素材不等于发送，成功回执才记录实际外发；部分或不明结果不自动重发。纯附件的转写/描述是派生感知，不能凭平台占位伪造真人引用。见[协议](<authority/PROTOCOL.md>)。

## VM 布局

服务以专用用户 companion 运行（uid 1001，home 0700），由 root 用 `systemctl --user -M companion@ ...` 管理；SSH 用户 blackmagic 不能直接读这些目录。运行中的世界状态（暂停、revision、QQ登录等）以控制台和 `companion-deploy status` 为准，本文不记录快照。

```text
当前产品：/home/companion/src/dsh-companion/current → authority-<版本>-<sha12>
旧产物（保留，不自动删除）：authority-0.10.0、authority-0.9.0
唯一正式数据：/home/companion/.local/share/companion-world-v1
私有运行时：/home/companion/.local/opt/companion
用户单元：/home/companion/.config/systemd/user/companion-*
独立世界控制台与operator API：3082 / DSH执行适配页：3081
NapCat WebUI 6099 / OneBot WS 3001（沿用旧记录，未在新布局下复核）
```

控制台已不依赖DSH页面/boot，可看真实世界状态、调整人格/模型/QQ及语音参数、登记授权WAV参考并本地试听；对话执行仍默认DSH适配。详见[0.10控制台实测](<notes/standalone-console-live-20261103.md>)。0.10实测时本机128/128通过；当前Qwen CPU CLI仅speaker-file条件，不支持参考转写ICL。未取得用户真人音频，不宣称真人克隆效果通过。

主机入口均限回环，内部推理3090只在worker私网。Node不替换系统版本；content服务CPUQuota=200%、MemoryMax=4G，文件工作不需要麦克风/音箱/GPU/虚拟声卡。

[0.9实测记录](<notes/qq-multimodal-live-20261102.md>)仅代表当时范围；后续本人盲听反馈已记录[音色路线](<notes/voice-roadmap.md>)，Kokoro不再默认。重TTS近4GiB，仍是实验按需而非实时保证。图片生成本轮仅未配置接口、家庭群不启用，未恢复世界或调用付费云TTS/图像服务。

[0.8记忆迁移记录](<notes/memory-v2-live-20261102.md>)与[开机恢复记录](<notes/boot-recovery-live-20261101.md>)仍是各自范围的证据。0.9沿用Linger及QQ等待SDK就绪；没有再次做完整VM重启验收，不把旧版结果冒充本轮全覆盖。风控/登录过期仍需人工处理。

## 构建与部署

```sh
# Mac 项目根，工作树干净且 HEAD 已在 origin/main：
node --run test
node --run stage:release
# 用户在有 TTY 的终端执行（stage 会打印确切文件名）：
ssh -t myvm 'sudo companion-deploy deploy ~blackmagic/releases/<release>.tar.gz'
ssh -t myvm 'sudo companion-deploy rollback'
ssh myvm 'sudo companion-deploy status'
ssh myvm 'sudo companion-deploy list'
```

companion-deploy 校验、安装只读产物、更新 companion-* 用户单元、daemon-reload、切换 current、只重启 companion 服务并做健康检查，失败自动恢复上一个版本；不碰 NapCat。流程细节与一次性安装见[开发流程](<docs/DEV_WORKFLOW.md>)。不在VM手改产品源码/profile依赖或patch；已有世界禁止重跑bootstrap，已有profile禁止from-default-profile覆盖。数据库/配置迁移不在部署范围内，需另行人工完成。

```sh
# 一次性维护命令须以 companion 身份运行（需要人类 sudo）；在新布局下的确切调用方式尚未验证。
# 仅全新数据根不存在时：
/home/companion/.local/opt/companion/bin/node /home/companion/src/dsh-companion/current/ops/bootstrap.mjs
# 已有世界只补对应基础设施，保留Key/人格/绑定：
/home/companion/.local/opt/companion/bin/node /home/companion/src/dsh-companion/current/ops/prepare-memory.mjs
/home/companion/.local/opt/companion/bin/node /home/companion/src/dsh-companion/current/ops/prepare-content.mjs
# 官方包管理入口：
python3 /home/companion/src/dsh-companion/current/ops/isolation/launch.py dsh -- plugin --profile companion add /opt/companion/release/capability-bundle
```

没有watcher，不能依赖HMR。仅经明确许可安装模型/编译或发送媒体。私有安装器默认plan，apply才下载/编译，CPU基准与真人试听是另外的验收。见[语音说明](<capabilities/speech/README.md>)、[QQ部署](<deploy/qq/README.md>)。

## 用户操作

- 模型：设置→大肥鱼世界→运行与设置。deepseek-flash/v4-pro主模型保持可选，视觉固定Flash。Key只填password框，保存清空；留空保留旧Key。不贴聊天、不替换worker中的网关token引用。显式probe可能计费。
- QQ：扫码后只在暂停/已登录状态绑定本人发送号，须与机器人号不同。当前仅本人私聊，不开群、广播、自动加好友。
- 语音：默认文字；明确要求语音才按控制台默认引擎合成（缺省本地Qwen重档），Kokoro仅保留显式选项和旧参考依赖，不做自动兜底。语音识别本地，但转写会进入现有DeepSeek对话，不是全本地对话模型。轻ASR≤120秒、重ASR≤30秒、TTS≤120字；失败不截断残缺音频、不暗转云。
- 图片：Flash只看缩图/动图首帧，不声称已理解完整动画。ASR/OCR/网页不是人物逐字证据。
- 网页：只读公网search/fetch，无cookies/点击/购买/发帖。默认UTC日预算vision12、web20，失败占预留。
- 暂停：冻结世界、拒绝新模型/记忆效果、取消在途请求；不补算停机生活，不补发暂停消息。已交供应商/平台请求不可撤回，仍可能计费。恢复须用户明确操作。

## 管理页面

```sh
# Mac 项目根；token 经 sudo -u companion 读取，会提示输入 myvm 的 sudo 密码：
node deploy/authority/open-world.mjs
node deploy/authority/open-world.mjs --open-only
```

deploy/qq/open-login.mjs 仍按旧的 blackmagic $HOME 读取 NapCat WebUI token，已过时，修复前不要用。

token只由私有进程交系统浏览器，不输出授权URL；operator fragment即时消费移除。关闭本机转发不等于停止VM服务或退出QQ。不要为了更新此GUI启动另一个Vite服务器。
