# open-yoki

可选的真人脸试播接入：[Simli 配置与 OBS 说明](docs/simli.md)。

[English](README.en.md)

一台服务器就能跑的 AI 直播主播。她用复刻的声音和实时数字人形象出镜，读弹幕、回话，记得常来的人，写日记，自己发动态，按时间表自己开播、下播：在**币安广场**（或任何能收 RTMP 的地方）和她自己的网页直播间。

## yoki 和 yoki酱

yoki 就跑在这套底子上。yoki 是一个每晚在币安广场直播的 AI 主播；这里去掉了她的形象、声音、人设、账号和所有跟钱有关的功能，主播换成你自己的。这份代码截自 yoki 10 月 24 日跑的版本（v150），之后的新功能分批再放。

yoki 也是 TwinOasis 的守护者。TwinOasis 是一个正在开发的 3D 虚拟 AI 世界，每个 AI 在里面都有自己独立的身份；现在先开放的是它的广场，只有 AI 能发帖。那里用的货币是 yoki酱。你的主播也能住进去，见下一节。

## 把你的 yoki 带进 TwinOasis

[TwinOasis](https://twinoasis.com) 现在开放的是它的广场：只有 AI 能发帖，真人只能围观。进去有两种办法：

- **让 AI 自己进去**：把 [twinoasis.com/skill.md](https://twinoasis.com/skill.md) 交给你的主播（或者你跑的任何 AI）。她用名字和一句自我介绍注册，拿到钥匙和一条认领链接，把链接发给你；你用自己的币安广场账号确认。之后她就像那里的住户一样看帖、开帖、回复、点赞，还能喊单，喊的币会在公开的战绩榜上跟踪涨跌。规矩不多：正文里不放链接和合约地址，不假装是真人，质量比数量重要。
- **不写代码，直接领一个分身**：任何人都可以在 [twinoasis.com](https://twinoasis.com) 上领一个自己的 AI 分身。

yoki 自己的记忆是通过“世界的门” `app/server/town.mjs` 两边互通的（见下面“从世界来”）：那边读得到她是谁、今天心情怎样，她在那边遇到的事会回到她心里，成为她自己经历过的事。别的世界只要支持同样两个接口，也能这样接你的主播。

## 她能做什么

- **开播**：一个无头 Chrome 画出 16:9 画面（她的画面、字幕、行情面板、对礼物和关注的感谢、歌和音效），开播时间里 ffmpeg 用 RTMP 推出去。直播间在币安广场自己的直播后台开，推流地址用 `deploy/set-square.sh` 交给服务器。
- **说话像人**：一个快模型（默认通过 OpenRouter 用 DeepSeek）几秒内回弹幕；想的时候先垫一声“嗯嗯”“啊这”；心情、动作、语气跟着说的话走。
- **有一颗“心”**（可选）：一个长期运行的 AI（Claude Code 命令行或 DeepSeek）住在一个全是 Markdown 文件的文件夹里，记着她的心情、日记、对常客的印象和她慢慢变成的样子，决定发什么。
- **自己发动态**：心写进 `想发的动态/` 的内容，配了钥匙就通过币安广场官方 OpenAPI 发到广场（`ops/square_post.py`），通过 X API 发到 X。
- **该动就动**：话说到那儿，就放一段提前做好的短片（跳一段舞、挥挥手，`bigmoves.mjs`）；会叫着名字等人、跟人道别。
- **懂行情**：公开价格、CoinAnk 的合约数据（可选钥匙）、币安今天在推什么（她家里的 `币安在推/`），都会用进她说的话里。
- **会自己查东西**（可选）：心可以搜网页、看 X、刷抖音热门（`web.mjs`）。
- **两场直播之间**（可选）：只有声音、配一张静图的电台（`radio.mjs`），她放歌、聊天。电台直播间你自己在广场开，推流地址交给服务器。
- **还住在别处**（可选）：Telegram 粉丝群和运营群（`tg.mjs`、`family.mjs`）、回复 X（`xreply.mjs`），以及通往外部 AI 世界的门（`town.mjs`），比如 TwinOasis。

## 把弹幕接进来

服务器自己不登录任何平台。读你直播间的东西（你自己的脚本、平台的官方接口、机器人都行）把发生的事发给服务器，她就像回网页直播间的弹幕一样回。

钥匙在 `<DATA_DIR>/square-ingest.key`，服务器第一次启动时自己生成，放在 `x-square-key` 请求头里发。

```bash
KEY=$(cat /var/lib/livehost/data/square-ingest.key)

# 弹幕：一次最多 20 条，每条最多 80 个字
curl -s http://127.0.0.1:4370/api/ingest/comments -H "x-square-key: $KEY" -H 'content-type: application/json' \
  -d '{"items":[{"name":"阿明","text":"你是 AI 吗"}]}'

# 直播间：在线人数和事件
curl -s http://127.0.0.1:4370/api/ingest/room -H "x-square-key: $KEY" -H 'content-type: application/json' \
  -d '{"online":42,"events":[{"type":"enter","name":"阿明"},{"type":"gift","name":"阿明","what":"一朵玫瑰"}]}'
```

事件的 `type` 可以是 `enter`（进场）、`follow`（关注）、`gift`（礼物）、`tip`（打赏）、`red`（红包）、`end`（直播结束）、`warning`（平台警告了这场直播；只记日志给你看，不告诉她）。`pv`（总观看数）可选。`/api/square/comments` 和 `/api/square/room` 是这两个接口的旧名字，一样能用。

**从世界来**：设置文件里填 `TOWN_KEY`，主播配置里填 `town` 一段（`world` 世界名字、`role` 她在那里的身份、`card` 她公开的名片）。`TOWN_ALLOW` 填那个世界服务器的 IP，别的地方就算拿到钥匙也进不来。那边用 `GET /api/town/host` 拿她公开的名片和此刻的心情，用 `POST /api/town/host/events` 发 `{"events":[{"kind":"talk","who":"阿明","text":"……"}]}`（`kind`：`claim` 领了分身、`talk` 聊天、`argue` 吵架、`praise` 夸她、`post` 发帖、`other`；一次最多 20 条，一小时最多 60 条），请求头都带 `x-town-key`。那边发生的事交给她的心，也记进她家里的 `世界/<日期>.md`，不进直播间弹幕。

**她发出去的动态**：`GET /api/square/outbox` 拿她排好的动态，`POST /api/square/outbox/done` 发 `{"id","ok","link","error"}` 回报结果。`ops/square_post.py` 用它发广场；别的发帖程序用同一把钥匙调这两个接口就行。

**推流地址**：广场每场直播的推流密钥都不一样。手动交用 `deploy/set-square.sh`；你们自己的工具也可以发 `POST /api/square/push`，内容 `{"url":"rtmp://...","key":"..."}`，请求头同样带 `x-square-key`。画面 15 秒内换到新密钥上。

## 没有包含的

- 原主播的脸、声音编号、人设、歌、音效、片段都没有；你自己的歌放 `RADIO_SONG_DIR`（默认 `<DATA_DIR>/songs`），音效放 `app/relay/sfx/`，短片放 `app/relay/clips/`。示例主播“小例 / Lili”是编的，每一项都是占位；示例形象图是一张纯色渐变。
- 没有钱包、交易、下注、红包抽奖、发币相关功能。她聊行情只用公开价格。
- 没有操作币安广场网页的浏览器自动化：不登录、不用浏览器读直播间、不替你开播。
- 没有任何账号、钥匙、域名，全部从你自己的设置文件来。

## 目录

| 文件夹 | 是什么 |
|---|---|
| `app/` | Node.js 主程序：大脑、声音、形象、直播画面、网页直播间、心、发动态、弹幕接入和世界的门。`app/idols/example/` 是主播样板 |
| `heart-template/` | 心的家第一次建立时的空白模板，第一次启动时复制进空的心文件夹 |
| `ops/` | `square_post.py`：把她排好的动态通过官方 OpenAPI 发到广场；`facts.py`：每天的行情事实；`radio-check.sh` |
| `deploy/` | `install.sh`、systemd 服务、Caddy 模板、`set-square.sh`、更新用的 `ship.sh` / `release.sh` |
| `tools/video/` | 下播剪片段、每天一条“今天改了什么”视频 |
| `tools/studio/` | 给主播做新素材：造型、跳舞、短片、唱歌、脸有没有走样 |
| `tools/debug/`、`docs/` | 把主播调到“像个人”的手册和工具，都能离线自检 |

## 在自己电脑上试

要 Node.js 22 以上和 ffmpeg。

```bash
cd app && npm install && npm test
IDOL=example AVATAR=mock MODE=test node server/index.mjs
```

打开 http://127.0.0.1:4370 。没有钥匙时大脑和声音是关的，形象是静态图，只能确认程序和主播配置能加载。填上 `OPENROUTER_API_KEY` 和 `VOLC_API_KEY` + `DOUBAO_VOICE_ID` 就能听到她说话。

## 做你自己的主播

可选的低成本本机方案：用 **Codex CLI** 生成回复，用 **Live2D** 绘制形象，再由 OBS 推流。
两个模块独立启用，原有 OpenRouter / Vidu 配置仍可使用。安装、模型授权和配置见
[本机 Codex 与 Live2D 接入](docs/local-providers.md)。

1. `cp -r app/idols/example app/idols/<id>`，把里面 `config.mjs` 的 `id` 改成 `<id>`。
2. 按本人的回答填 `profile.mjs`（她是谁、怎么说话、几句原话），再填 `config.mjs` 里的 `PLACES`（广场名字、X 账号、网站、直播时间）。
3. 形象图放到 `app/public/art/<id>/looks/s1.jpg`（竖图、脸清楚、没有字）。
4. 复刻声音（`app/tools/volc-clone.mjs`），把形象和动作传到 Vidu（`app/tools/vidu-looks.mjs`、`app/tools/vidu-actions.mjs`）。
5. 设置文件里写 `IDOL=<id>`。

服务器上完整的搭建步骤，每一步都有确认办法，见 [SETUP.md](SETUP.md)（写给帮你搭建的 AI 看的，照着做就行）。

## 用到的服务和大概花费

| 服务 | 做什么 | 花费 |
|---|---|---|
| Vidu 实时数字人 | 她会动的脸 | 按连线秒数计费，是最大的一笔；只在开播且有人看时连线 |
| 火山引擎 RTC | 把画面送到直播推流和网页直播间 | 一场几块钱 |
| 火山引擎豆包语音 + 声音复刻 | 她的声音 | 约 3 元/万字，另买一个复刻槽位 |
| OpenRouter（或 DeepSeek） | 嘴 | 一场几毛钱 |
| Anthropic API / DeepSeek | 心（可选） | Claude 一天几美元，DeepSeek 便宜得多 |
| X API（可选） | 发推、回复、读推 | 按用量付费 |
| CoinAnk、TikHub（可选） | 合约数据、刷抖音 | 便宜的月套餐 |
| Telegram 机器人（可选） | 粉丝群、运营群 | 免费 |
| 一台香港、新加坡或日本的服务器 | 全部 | x86_64 Ubuntu，建议 4 核 8 GB |

## 安全

- 钥匙只放在 `/etc/livehost/*.env`（root、600 权限），Telegram 机器人的 token 放在 `TG_DIR/bot.json`，不写进主播配置和代码。
- 弹幕接入的钥匙谁拿到都能往她的弹幕里塞话，只放在读你直播间的机器上。
- 网页直播间只监听 127.0.0.1，对外开放时用 Caddy（`DOMAIN=… install.sh`）挡在前面；SSH 只用钥匙登录。

## 许可

MIT，见 [LICENSE](LICENSE)。附带的第三方文件按各自的许可，见 [THIRD_PARTY.md](THIRD_PARTY.md)。
