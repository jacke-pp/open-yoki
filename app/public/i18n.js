// The page text in Chinese and English. Keys are the Chinese text with {slot}s; the HTML carries the English as its
// default text. English is the default; a browser whose first language is Chinese opens in Chinese, and a choice made
// with the switch is remembered. Her own spoken lines stay as she said them.
// Host-specific words (her name) are never written here: the page calls setVars({ name }) once /api/state arrives.
const KEY = 'livehost.lang';
const EN = {
  '{name} · 陪你熬夜的 AI 主播': '{name} · the AI host who stays up with you',
  '{name} 是 AI 直播主播：读弹幕、记得常来的人、顺嘴聊行情，每晚在币安广场和这里直播。': '{name} is an AI live host. She reads the chat, remembers the regulars and talks about the market, every night on Binance Square and here.',
  '切换语言': 'Switch language',
  '现在没在播': 'Off air',
  '直播中': 'Live now',
  '连接断了，正在重连': 'Reconnecting',
  '{name} 是陪你熬夜看盘的 AI 主播。': '{name} is an AI host who stays up with you.',
  '她读弹幕、记得常来的人，顺嘴聊聊行情。每晚在币安广场和这里同时直播，两边的话她都回。': 'She reads the chat, remembers the regulars and talks about the market. Every night she streams on Binance Square and here at the same time, and answers both.',
  '起个昵称进来': 'Pick a nickname',
  '跟她说句话，或者点她做个动作': 'Say something, or tap a move',
  '明天再来，她还记得你': "Come back tomorrow. She'll remember you",
  '跟她打个招呼': 'Say hi to her',
  '去币安广场看她直播': 'Watch her on Binance Square',
  '币安广场直播间马上开。': 'Her Binance Square room opens soon.',
  '她的 X': 'Her X',
  '她的 Telegram 群': 'Her Telegram group',
  '在看': 'Watching',
  '她记得的常客': 'Regulars she remembers',
  '开播时间': 'Show time',
  '她的日记': 'Her diary',
  '每晚下播后她自己写一篇。': 'She writes one herself after every show.',
  '直播画面': 'Live picture',
  '画面接入中…': 'Connecting the picture…',
  '角色加载失败，暂用静态画面': 'The avatar could not load. Showing the still picture.',
  '连接真人形象': 'Connect avatar',
  '断开': 'Disconnect',
  '连接后开始计费，单次试播最多 {seconds} 秒；切换页面会断开。': 'Connecting starts billing. Each preview lasts at most {seconds} seconds and disconnects when this page is hidden.',
  '仅可在这台电脑的本地页面连接真人形象。': 'Open this room on the host computer to connect the avatar.',
  '真人形象尚未配置。': 'The avatar is not configured yet.',
  '未连接，显示静态画面和字幕。': 'Disconnected. Showing the still picture and captions.',
  '真人形象连接中…': 'Connecting the avatar…',
  '真人形象已连接': 'Avatar connected',
  '试播已结束，可手动重新连接。': 'The preview has ended. You can reconnect manually.',
  '真人形象连接失败，已断开；可手动重试。': 'The avatar connection failed and was closed. You can retry manually.',
  '下播后已断开真人形象。': 'The avatar is disconnected while off air.',
  '她还没上线': "She's not on yet",
  '下次开播': 'Next show',
  '每晚 {from}–{to}（你的当地时间），币安广场和这里同时开。': 'Every night {from}–{to} your time, on Binance Square and here at the same time.',
  '开声音': 'Sound on',
  '关声音': 'Sound off',
  '弹幕': 'Chat',
  '她现在看的盘': "The board she's watching",
  '她能查到币安上 {n} 个币：现货、合约和 Alpha。': 'She can look up {n} coins on Binance: spot, futures and Alpha.',
  '今晚她猜 <b>{coin}</b> 明天这时候{dir}，当时 {price}。': "Tonight's guess: <b>{coin}</b> {dir} this time tomorrow. It was {price}.",
  '更高': 'higher',
  '更低': 'lower',
  '上一次猜 {coin}：{from} 到 {to}，她{verdict}。': 'Last guess on {coin}: {from} to {to}. She {verdict}.',
  '说对了': 'got it right',
  '说错了': 'got it wrong',
  '看盘记录 {right}/{total}': 'Record {right}/{total}',
  '每晚开播她会猜一次行情，第二天自动对答案。不是投资建议。': 'Every show she makes one market guess. The next day it gets checked against the price. Not financial advice.',
  '起个昵称，她会这样叫你': "Pick a nickname. She'll call you that",
  '比如：熬夜的老王': 'e.g. night owl',
  '进来': 'Join',
  '换个昵称': 'Change name',
  '点她做个动作': 'Tap a move',
  '跟她说点什么': 'Say something to her',
  '发送': 'Send',
  '{name} 是 AI，她说的不是投资建议。': '{name} is an AI. Nothing she says is financial advice.',
  // live text
  '每晚 {from}–{to}': 'Nightly {from}–{to}',
  '网页': 'Web',
  '回复 <b>{who}</b>：{text}': 'Replying to <b>{who}</b>: {text}',
  '刷到{src} <b>{who}</b>：{text}': 'Seen on {src} <b>{who}</b>: {text}',
  '刷到{src}：{text}': 'Seen in {src}: {text}',
  '广场': 'Binance Square',
  '推特': 'X',
  '快讯': 'the news',
  '热搜': 'the trending list',
  '币安在推': 'Binance promos',
  '她回了': 'answered',
  '还没人说话，第一句留给你。': 'Nobody has said anything yet. The first line is yours.',
  '点了「{a}」': 'asked for: {a}',
  '你是 {name}。说话进弹幕，她挑着回。': "You're {name}. Your lines go into the chat and she picks what to answer.",
  '收到，她做完手上这句就来。': "Got it. She'll do it after this line.",
  '发出去了，她看到了。': 'Sent. She saw it.',
  '先起个昵称': 'Pick a nickname first',
  '{m}月{d}日': '{mon} {d}',
  '出错了（{status}）': 'Something went wrong ({status})',
  '大脑': 'Brain', '配音': 'Voice', '画面': 'Picture', '公屏': 'Chat', '正常': 'OK', '出错': 'error', '关闭': 'off',
  // moves (the host config may add more; a move without an English name shows as written)
  '挥手': 'Wave', '比心': 'Heart', '眨眼': 'Wink', '捂脸': 'Peek', '飞吻': 'Kiss', '撒娇': 'Pout',
  '点头': 'Nod', '歪头': 'Head tilt', '看手机': 'Checks phone', '看屏幕': 'Looks at screen', '指屏幕': 'Points at screen',
  '后仰笑': 'Laughs back', '托腮': 'Chin in hand', '撩头发': 'Hair flip', '摊手': 'Shrug', '摇头': 'Shakes head',
  '伸懒腰': 'Stretch', '扶帽子': 'Fixes cap', '捧脸笑': 'Face in hands', '惊讶': 'Surprised', '叹气': 'Sigh', '撇嘴': 'Pout lips',
  '得意笑': 'Smug grin', '发呆': 'Zones out', '抿嘴笑': 'Tight smile', '眯眼笑': 'Squint smile', '憋笑': 'Holds a laugh',
  '低头笑': 'Shy laugh', '眼睛一亮': 'Eyes light up', '挑眉': 'Raised brow', '愣一下': 'Double take', '往上看想': 'Thinks',
  '眯眼琢磨': 'Squints', '斜眼瞄': 'Side-eye', '小白眼': 'Eye roll', '嘴角一撇': 'Smirk', '坏笑': 'Sly grin',
  '眼神变软': 'Softens', '抿嘴点头': 'Small nod', '皱眉': 'Frown', '瞪一眼': 'Glare', '不好意思笑': 'Sheepish smile',
  '认真听': 'Listens', '瞄弹幕笑': 'Reads chat, laughs', '轻轻叹': 'Soft sigh', '鼓腮': 'Puffed cheeks', '摸下巴': 'Strokes chin',
  '双手合十': 'Hands together', '握拳加油': 'Fist pump', '拍手': 'Claps', '竖大拇指': 'Thumbs up', '嘘': 'Shh',
  '凑近镜头': 'Leans in', '扶额': 'Facepalm', '捂心口': 'Hand on heart', '托腮笑': 'Chin-in-hand smile', '抱胸': 'Arms crossed',
  '捂嘴笑': 'Covers a laugh', '打哈欠': 'Yawn', '喝水': 'Sips water',
  // moods
  '平静': 'Calm', '开心': 'Happy', '兴奋': 'Hyped', '失落': 'Down', '暴躁': 'Grumpy',
  '手势舞': 'Hand dance', '剪刀手': 'Peace sign', '转椅子': 'Spin', '站着挥手': 'Wave', '站着转圈': 'Twirl', '站着跳舞': 'Dance', '踏步拍手': 'Clap along', '站着比心': 'Big heart', '鞠躬': 'Bow',
  // server errors
  '换个昵称：1 到 12 个字，不能带链接或“官方”“客服”': 'Try another nickname: 1 to 12 characters, no links, nothing that sounds official',
  '没有登录': 'Not signed in', '先进直播间': 'Pick a nickname first', '先起个昵称进来': 'Pick a nickname first',
  '没有这个动作': "She doesn't know that move", '她现在没在直播': "She's off air right now",
  '点太快了，等她做完这个': 'Too fast. Let her finish this one.', '点播排满了，过一会儿再点': 'Too many requests waiting. Try again in a bit.',
  '说点什么再发': 'Write something first', '一条最多 80 个字': '80 characters max', '发太快了，8 秒一条': 'Too fast: one line every 8 seconds', '发太快了，等一下': 'Too fast, wait a moment',
  '这台设备进来的游客太多了，过一会儿再来': 'Too many names from this device. Try again later.',
  '请求格式不对': 'Bad request', '服务器出错了': 'Server error',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A saved choice wins; otherwise Chinese only for a Chinese browser, English for everything else.
function pick() {
  try { const v = localStorage.getItem(KEY); if (v === 'zh' || v === 'en') return v; } catch {}
  const langs = (typeof navigator !== 'undefined' && (navigator.languages?.length ? navigator.languages : [navigator.language])) || [];
  return String(langs[0] || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}
export let lang = pick();
export const dict = EN;
let vars0 = {};

// Page-wide slots ({name}); a call's own vars win.
export function setVars(v) { vars0 = { ...vars0, ...v }; }

export function t(zh, vars = {}) {
  vars = { ...vars0, ...vars };
  let s = lang === 'en' ? (EN[zh] ?? zh) : zh;
  if (lang === 'en' && 'm' in vars) vars = { ...vars, mon: MONTHS[Number(vars.m) - 1] };
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

// A text with a {slot} that is not known yet keeps the HTML's own default until it is.
const ready = key => [...key.matchAll(/\{(\w+)\}/g)].every(m => vars0[m[1]] != null && vars0[m[1]] !== '');

export function applyStatic(root = document) {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  for (const el of root.querySelectorAll('[data-i18n]')) if (ready(el.dataset.i18n)) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('*')) {
    for (const a of el.getAttributeNames()) if (a.startsWith('data-i18n-') && ready(el.getAttribute(a))) el.setAttribute(a.slice(10), t(el.getAttribute(a)));
  }
}

export function setLang(next) {
  lang = next;
  try { localStorage.setItem(KEY, next); } catch {}
  applyStatic();
}
