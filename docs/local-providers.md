# 本机 Codex 回复与 Live2D 形象

这两个可选模块分别替换回复模型和画面，原有 OpenRouter、Vidu、静态图仍按原配置工作。
人设、弹幕队列、常客记忆、行情上下文和日记继续使用主程序的逻辑。

## 运行方式

```text
网页或平台弹幕 → 主播上下文 → Codex CLI → 回复文本
                                      ↓
                            豆包语音 → 本机 Live2D → OBS → 平台 RTMP
```

Live2D 在观看页面中绘制，不建立 Vidu 会话或火山 RTC 房间。
本机推流由 OBS 采集页面完成；这个版本没有把 Live2D 接进原先的云端推流服务。
平台直播权限、当场推流地址及平台弹幕读取仍由运营方准备，弹幕沿用已有 ingest 接口。

## 环境与安装

- Node.js 22 以上；先在 `app/` 执行 `npm ci`、`npm test`。
- 使用 Codex 时安装支持权限配置的 Codex CLI（0.138 以上），在本机完成 `codex login`。
- 使用 Live2D 时，自行准备有使用授权的 Cubism `.model3.json` 模型及其完整资源目录。
  图片本身不是可直接运行的 Live2D 模型。
- 从 [Live2D 官方 SDK](https://www.live2d.com/en/sdk/download/web/) 获取 Cubism Core。
  Core、SDK 以及模型各自的许可仍适用，不属于本项目的 MIT 代码。

在 `app/` 运行可选安装工具，`PATH` 换成 SDK 中的实际文件：

```bash
node tools/setup-live2d.mjs --core PATH/TO/live2dcubismcore.min.js
```

工具校验固定版本的 PixiJS 6.5.10、pixi-live2d-display 0.4.0 下载包，然后把浏览器运行库和许可文件
放在 `public/vendor/live2d/`。它不下载角色，也不自动接受 Cubism Core 的许可。
默认安装不新增 npm 运行依赖，只有启用 Live2D 的页面才加载这些脚本。

把模型放入 `app/public/art/<id>/live2d/`，保持贴图、动作等相对路径完整。
运行库目录和这些模型目录已被 Git 忽略，不应提交到上游。

## 先验证画面

以下参数均可用环境变量或原有服务配置文件设置；环境变量优先于主播配置：

```bash
IDOL=example AVATAR=live2d LIVE2D_MODEL=/art/example/live2d/host.model3.json \
  MODEL_OFF=1 VOICE_OFF=1 MODE=test NEWS_OFF=1 MARKET_OFF=1 node server/index.mjs
```

浏览器打开 `http://127.0.0.1:4370/`。
模型或运行库没有正确安装时，页面显示原有静态图，并提示画面加载失败。
资产路径必须同源；没有运行库时不会改为从第三方 CDN 加载代码。

## 启用 Codex 回复

保持本机 CLI 已登录，设置：

```dotenv
MODEL_PROVIDER=codex
CODEX_BIN=codex
CODEX_TIMEOUT_MS=20000
CODEX_LONG_TIMEOUT_MS=45000
```

可用 `CODEX_MODEL` 显式选择该账号可用的模型；留空使用 CLI 默认模型。
删除 `MODEL_OFF=1` 才会生成回复。首次建议关闭行情和新闻轮询，只测试几条弹幕。
不要把测试模式的服务直接暴露到公网。

Codex 返回的仍是原来 `ask(messages, { long, signal })` 接口中的文本。
每次调用使用独立临时目录和 stdin；不加载个人配置、项目指令、MCP、插件或工具，
不允许模型读取电脑上的其他文件或执行命令。超时、取消和退出时会终止子进程并清理目录。
观众弹幕只作为对话内容传入，密钥不放进提示词。

现有 CLI 登录可使用计划额度，也可能对应 API 计费，取决于用户实际登录方式。
程序不读取或复制登录令牌，也不会在失败时自动切换到另一家付费服务。
`/api/health` 中 `modelSpend.usd` 为 `null`、`costKnown` 为 `false`，表示无法在这里报价，
不表示推理免费。额度、账号可用模型和接入资格以官方规则为准。
本地个人工具与商业或托管应用的接入规则不同，参见
[官方认证文档](https://learn.chatgpt.com/docs/auth)及
[Sign in with ChatGPT](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)。

Codex 只替换主回复后端；可选的全天自主“心”、Telegram 运营回复等仍使用原来的配置，
不会因为设置 `MODEL_PROVIDER=codex` 自动开启或迁移。

## 语音、表情与动作

语音继续使用原有 `VOLC_API_KEY` 和 `DOUBAO_VOICE_ID`。
没有语音配置也可以验证字幕和动作；开启网页声音后，TTS 音频的实时音量驱动嘴形。
浏览器要求用户手势才能开启声音，先点页面的声音按钮。

主播配置中的 `avatar.live2d` 可定义模型及映射。例如，下列名字必须与实际模型中的名字匹配：

```js
live2d: {
  model: '/art/my-host/live2d/host.model3.json',
  expressions: { happy: 'smile', sad: 'sad' },
  motions: { '挥手': { group: 'TapBody', index: 0 } },
  credit: 'Required attribution from the model license',
}
```

没有映射的表情或动作跳过，正常说话不受影响；同一条台词及静默动作不会随快照重复触发。
模型需要署名时，通过 `credit` 或 `LIVE2D_CREDIT` 设置；署名会保留在 OBS 舞台画面中。
模型文件中的预置声音引用会被移除，以免与主播 TTS 同时播放。
运行库可通过 `LIVE2D_CORE`、`LIVE2D_PIXI`、`LIVE2D_DISPLAY` 指向其他同源本地文件。

## OBS

用浏览器来源或窗口采集打开：

```text
http://127.0.0.1:4370/?obs=1&landscape=1
```

这是横屏舞台视图，保留字幕，隐藏聊天和个人资料。
竖屏使用 `?obs=1`。声音按钮用于首次启用音频；实际音频采集方式按 OBS 的 macOS 设置验证。
推流地址和推流密钥直接交给 OBS，不必填写 Vidu 或 RTC 凭证。

## 验证与贡献边界

`npm test` 使用假子进程和假浏览器运行时，不登录账号、不调用真实模型。
测试覆盖模型选择、子进程隔离、取消清理、Live2D 生命周期、音频到嘴形映射和服务端音频发布。
真实 Core、真实模型、真实语音和特定机器上的渲染速度仍需单独验收。

提交贡献时只包含接入模块、文档和测试；不包含个人角色、人设、音色、账号、推流密钥或运行数据。
