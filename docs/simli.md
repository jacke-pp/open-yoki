# Simli 真人形象试播

这是一个本机操作者/OBS 接入：保留现有回复和配音，把 TTS 音频交给 Simli 生成同步真人画面。
普通观众打开直播间不会自动创建 Simli 会话。Simli 的云视频不会由这版代码转播给所有网页观众；
可通过本机 OBS 采集画面推到直播平台。

## 安装

在 `app/` 运行：

```sh
npm install
npm run build:simli
```

构建使用锁定的 `simli-client@3.2.0` 和 esbuild，生成同源浏览器模块
`public/vendor/simli/client.js` 及第三方许可文件。这些生成文件被 Git 忽略。
正常页面不会加载 SDK；只有手动连接时才加载。生产安装省略开发依赖时，需先在构建机器完成此步骤，
再把生成的 `public/vendor/simli/` 一起部署。

构建对 SDK 3.2.0 做了固定源码校验后的生命周期兼容修补：只尝试一次连接，
停止后取消首帧计时并关闭信令、transport 和 AudioContext，避免上游默认自动重试与资源残留。
源码或版本不匹配时构建失败，不会静默把补丁应用到新版本。升级时需重新审核该补丁。

## 配置

从 [Simli 控制台](https://app.simli.com/) 取得已有的 API Key 和官方模板或自己形象的 Face ID。
将它们放进项目根目录的 `.env.simli.local`，该文件已被 `.gitignore` 的 `.env.*` 规则排除。
不要把密钥放进主播配置、前端代码或聊天。

```dotenv
IDOL=example
AVATAR=simli
SIMLI_API_KEY=your-key
SIMLI_FACE_ID=your-face-id
SIMLI_MAX_SESSION_LENGTH=120
SIMLI_MAX_IDLE_TIME=60
MODEL_PROVIDER=codex
MODEL_OFF=1
VOICE_OFF=1
NEWS_OFF=1
MARKET_OFF=1
MODE=test
PORT=4370
```

限制配置文件权限，然后在 `app/` 启动：

```sh
chmod 600 ../.env.simli.local
node --env-file=../.env.simli.local server/index.mjs
```

打开 `http://127.0.0.1:4370/`，在舞台上点“连接真人形象”。网页不会自动连接或无限重试。
默认每次最多 120 秒；点击断开、页面隐藏、离开或下播时会停止会话。
刷新页面不会恢复之前的连接，也不会重播旧台词。
`MODEL_OFF=1` / `VOICE_OFF=1` 只用于先验收画面；启用真实回复和说话时删除相应配置，
并按原项目配置 `VOLC_API_KEY`、`DOUBAO_VOICE_ID`（或原有 fal 配音）。
仅连接画面不代表已完成配音、弹幕或平台推流验收。

## 音频与 OBS

服务器沿用原有的 TTS 音频文件接口；浏览器只取新台词的同源音频，解码后转换成
16kHz、单声道、PCM16 little-endian，每块最多 6,000 字节并按实时速度发送。
播放 Simli 返回的同步声音，避免与原 TTS 重复播放。
单条音频最长 30 秒，待播队列最多 3 条；超出或出错时结束试播，交由操作者检查后再连接。

OBS 横屏舞台：`http://127.0.0.1:4370/?obs=1&landscape=1`。
竖屏舞台：`http://127.0.0.1:4370/?obs=1`。
在 OBS 的交互窗口中点连接并开启声音，实际音频采集方式仍需按操作系统设置验收。
试播时保持该采集页面可见；网页隐藏会主动断开。

## 凭据、会话与计费

API Key 只交给服务端的固定官方 `https://api.simli.ai/compose/token` 接口。
网页通过同源、本机专用 `POST /api/simli/session` 获取短期 token；
公开直播间快照不包含 API Key 或 session token。
本机接口校验 loopback socket、Host、Origin，并拒绝代理转发头；同时只允许一条试播租约，
限制创建频率。远程操作者和生产多观众分发需要单独设计认证和转播，不能直接放开此接口。

Simli 按整个连接时间计费，静默也计时；默认试播限时不是账号总预算控制。
开始前可在 Simli 后台设置支出上限。默认不会自动购买套餐、打开超额付费或升级账号。
已取得的短期 token 仅用于当次连接，不保存到磁盘或公共状态。
关闭浏览器失败时仍受 Simli 服务端的最长连接时间与静默时间约束。

官方资料：[JS SDK](https://docs.simli.com/api-reference/javascript)、
[音频格式](https://docs.simli.com/api-reference/audio-info)、
[token 接口](https://docs.simli.com/api-reference/endpoint/webrtc/startAudioToVideoSession)、
[价格与计费](https://www.simli.com/pricing)。
