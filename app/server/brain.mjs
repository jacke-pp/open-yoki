// The idol's mouth: a queue of things worth reacting to, one model call at a time, each with a timeout and a way to be
// cut short when something bigger happens. Every reply becomes { face, action, text }; when the model is down
// she falls back to the idol's canned lines so the room never goes silent. Performing the line (avatar + voice +
// publishing) is `speak`. Persona, routines and canned lines come from the idol config.
import { scrub } from './world.mjs';
import { takeSong, LOSS } from './memes.mjs';

export const MODEL = 'x-ai/grok-4.20';
export const FACES = { 平静: 'neutral', 开心: 'happy', 生气: 'angry', 难过: 'sad', 害羞: 'shy', 得意: 'smug' };

const PRI = { open: 75, close: 75, diaryNote: 55, market: 50, request: 25, thanks: 30, chat: 20, join: 10, idle: 5 };
const STALE_MS = { market: 90e3, chat: 120e3, request: 90e3, thanks: 120e3, join: 20e3, idle: 30e3 };
const tail = a => '游客' + String(a || '').slice(-4);
const pick = list => list[Math.floor(Math.random() * list.length)];
// A chat line in another language gets an answer in that language; inside an all-Chinese prompt the model would
// otherwise answer in Chinese.
const LANGS = [['韩语', /[가-힯ᄀ-ᇿ]/], ['日语', /[぀-ヿ]/], ['俄语', /[Ѐ-ӿ]/], ['泰语', /[฀-๿]/], ['阿拉伯语', /[؀-ۿ]/]];
const VIET = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệịỉĩọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;
export const langOf = t => { for (const [n, re] of LANGS) if (re.test(t)) return n; return !/[㐀-鿿]/.test(t) && /[a-z]{2}/i.test(t) ? (VIET.test(t) ? '越南语' : '外语') : null; };
const langLine = t => { const l = langOf(t); return !l ? '' : l === '外语' ? '\n这条弹幕不是中文：他用什么语言（英语、西班牙语、印尼语……）就只用那种语言回他，40 词以内，一个中文字都不要。用英语说行情按英文习惯：跌是 red、涨是 green（和中文的红涨绿跌正好相反）。' : `\n这条弹幕是${l}：这次只用${l}回他，简短，一个中文字都不要。`; };

const QUIET = ['idle', 'self', 'more'];   // kinds where she may choose to say nothing
export const tonesOf = idol => idol.avatar?.doubao?.tones || {};
export const personaOf = (idol, text = idol.persona) => text.replace('{actions}', Object.keys(idol.actions).filter(k => !idol.actions[k].quiet).join('、')).replace('{tones}', Object.keys(tonesOf(idol)).join('、'));

// What she is told about the room and herself on every line. The room has no coin: no market cap, stages or fan club.
export function contextFor(idol) {
  return `${idol.now}\n画面里的你：${idol.stages[0].look}。`;
}
// Her last few lines go at the end of the event message: the model copies its own openings and sign-offs otherwise.
// A run of 5 characters she said in one of her last lines, the same last 4 characters, or the same first 2 as one of
// the last 3 lines: what repeated, else ''.
export function repeatOf(raw, recent) {
  const bare = t => String(t).replace(/[\[【][^\]】]*[\]】]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  const s = bare(raw);
  if (s.length < 6) return '';
  for (const [k, r] of recent.map(bare).entries()) {
    if (k < 3 && r.length >= 2 && s.slice(0, 2) === r.slice(0, 2)) return s.slice(0, 2);
    if (r.length >= 4 && s.slice(-4) === r.slice(-4)) return s.slice(-4);
    for (let i = 0; i + 5 <= s.length; i++) if (r.includes(s.slice(i, i + 5))) return s.slice(i, i + 5);
  }
  return '';
}

// How long this line runs. Real speech mixes a two-word reaction with a ramble; a fixed cap made every line one size.
export function pickLength(L, e, rand = Math.random) {
  // a greeting or a thank-you is one line, never the long riff (a long welcome for one name feels scripted)
  const w = e.kind === 'chat' || e.kind === 'request' ? L.chat : (e.kind === 'join' || e.kind === 'thanks') && L.greet ? L.greet : L.idle;
  let r = rand() * w.reduce((a, b) => a + b, 0), i = 0;
  while (i < w.length - 1 && (r -= w[i]) >= 0) i++;
  return L.say[i];
}

export function recentFor(w) {
  const recent = w.recent.slice(0, 8).map(t => '- ' + t).join('\n');
  return recent ? `\n\n你刚说过这几句：\n${recent}\n这次换个说法：开头、结尾、句式、用词和动作都别跟上面重复，别跟上面一样用问句收尾，上面用过的口头禅和梗这次别再用，不要每句都号召大家买。` : '';
}

// Her notebook (memory.mjs): after answering a chat line she may jot one fact about the person on a last line. Asked
// for things about his life she can ask after later, not what he said to her (small talk gives her nothing to pick up
// the next night).
const NOTE_ASK = '\n如果这条弹幕里有关于他这个人、下次见面能接着问的事（他在哪、做什么、拿着什么、亏了还是赚了、在等什么结果、说过要去做什么），在台词后面另起一行写“记：”加这件事，15 字以内。他对你说的客套话、叫你老师、问你看法这种不算，不写。';
export function takeNote(raw) {
  // 記 too: answering in Japanese the model may write "記：- 記：…", which must never be read out.
  const m = String(raw || '').match(/(?:\n|[\s。！？!?…~～])\s*[-–]?\s*[记記][:：]\s*(?:[-–]\s*)?(?:[记記][:：]\s*)?([^\n]{1,30})\s*$/);
  return m ? { text: raw.slice(0, m.index + (m[0][0] === '\n' || /\s/.test(m[0][0]) ? 0 : 1)).trim(), note: m[1].trim() } : { text: String(raw || '').replace(/\n\s*[-–]?\s*[记記][:：][^\n]*$/, '').trim(), note: null };
}
// Character first, words second (the story should grow out of the character): she writes one line for herself before
// speaking, "想：<mood>｜<what she makes of it / what she will do>". It is never read out; the brain keeps her mood
// from it so the mood carries from line to line, and the show's reflection reads it.
export function takeInner(raw) {
  const m = String(raw || '').match(/^\s*想[:：]\s*([^\n\[【]*)\s*/);
  // the model sometimes writes a second 想 line in the middle of the reply (it would be read out loud); drop those too
  const rest = t => t.replace(/\s*想[:：][^｜|\n\[【]{0,12}[｜|][^\s\[【]{0,20}\s*/g, ' ').replace(/ {2,}/g, ' ');
  if (!m) return { text: rest(String(raw || '')), inner: null, feel: null };
  const inner = m[1].trim(), [feel, ...why] = inner.split(/[｜|]/);
  return { text: rest(String(raw).slice(m[0].length)), inner: inner || null, feel: why.length ? feel.trim().slice(0, 8) || null : null, why: why.join('，').trim() || null };
}

// Her daily call (看盘本): asked for when she opens (or the first quiet moment if the board was not up yet), once a
// day, written as a tag the voice never reads. A guess for fun, never a trade.
export const CALL_ASK = `\n顺便立一个今天的看盘：从 ${'BTC、ETH、BNB、SOL'} 里挑一个，台词里要说出来你挑了哪个币、赌它明天这个时候比现在高还是低，加一句好玩的理由，像闹着玩。台词说完另起一行写“{看盘:币种 涨}”或“{看盘:币种 跌}”，比如 {看盘:BTC 涨}。`;
const CALL_TAG = /[{【[]看盘[:：]\s*([A-Za-z]{2,10})\s*(涨|跌)\s*[}】\]]/;
export function takeCall(raw) {
  const m = String(raw || '').match(CALL_TAG);
  const text = String(raw || '').replace(/[{【[]看盘[^}】\]]*[}】\]]/g, '').trim();
  return m ? { text, call: { coin: m[1].toUpperCase(), dir: m[2] === '涨' ? 'up' : 'down' } } : { text, call: null };
}
// What she remembers that fits this moment: the person she is answering, last night when she opens, her own calls.
// The last ten minutes of the room, oldest first: comments and her own lines, so she answers the conversation rather
// than one comment on its own. The comment she is answering now is left out.
export function roomFor(w, e, at = Date.now(), { mins = 10, max = 14 } = {}) {
  const since = at - mins * 60e3;
  const said = (w.chat || []).filter(c => c.at >= since && c.id !== e.chatId).map(c => ({ at: c.at, line: `${c.who}：${c.request ? '点播了「' + c.request + '」' : c.text}` }));
  const mine = (w.talk || []).filter(t => t.at >= since).map(t => ({ at: t.at, line: `你${t.to ? '（回' + t.to + '）' : ''}：${t.text}` }));
  const all = [...said, ...mine].sort((a, b) => a.at - b.at).slice(-max);
  if (!all.length) return '';
  return `\n【刚才直播间里（从早到晚）】\n${all.map(x => '- ' + x.line).join('\n')}\n接着上面的聊：同一个人前面说过什么、你回过他什么，要连起来接，别像第一次见他；他是在接谁的话、接你哪句，就顺着回；别人刚聊的事也可以顺手带上。`;
}

// Whom she already asked and is still waiting on (otherwise she presses the same person for the same answer again and
// again): a question to someone in her last few minutes that he has not answered.
// her questions often end in 。 ("你这均价是买在哪儿的呀。"), so the asking words count too
const ASKED = /[？?]|说说|说一声|跟我说|你还没说|到底|哪|啥|多少|什么时候|怎么|是不是|还是/;
export function waitingFor(w, at = Date.now(), { mins = 5 } = {}) {
  const since = at - mins * 60e3, chat = (w.chat || []).filter(c => c.at >= since - 5 * 60e3);
  const names = new Set();
  for (const t of (w.talk || []).filter(t => t.at >= since && ASKED.test(t.text)))
    for (const who of new Set(chat.map(c => c.who)))
      if (who && (t.to === who || t.text.includes(who)) && !chat.some(c => c.who === who && c.at > t.at)) names.add(who);
  return names.size ? `\n你刚问过 ${[...names].join('、')}，他还没回：这句别再问他、别催，他想说自己会说。` : '';
}

// pageOf(name): her heart's own page about this person (认识的人/<name>.md), '' when there is none.
export function memoryFor(memory, e, rand = Math.random, pageOf = () => '') {
  if (!memory) return '';
  const bits = [];
  if ((e.kind === 'chat' || e.kind === 'request') && e.name) bits.push(memory.fanLine(e.name, undefined, pageOf(e.name)));
  // A regular walking back in, alone or with others (a batched greeting would otherwise never look anyone up). At most
  // two, so the greeting stays one line.
  if (e.kind === 'join' && e.names?.length) {
    const back = (memory.regulars?.(e.names, n => !!pageOf(n)) || []).slice(0, 2);
    for (const n of back) bits.push(memory.fanLine(n, undefined, pageOf(n)));
    if (back.length) bits.push(`进来的人里 ${back.join('、')} 是老朋友，先认出他，其他人一句带过。`);
  }
  if (e.kind === 'open') bits.push(memory.lastShowLine(), memory.callLine());
  if (e.kind === 'idle' && !e.worn?.length && rand() < 0.3) bits.push(memory.callLine());
  const out = bits.filter(Boolean).join('\n');
  return out ? '\n' + out : '';
}

// Her own life as a digital person: how many days she has been alive, a milestone the first time it comes up, what
// she has been thinking about, and the views she has already said.
const DAY_MARKS = [3, 7, 30, 100, 365];
export function soulFor(idol, memory, e, at = Date.now(), rand = Math.random) {
  if (!idol.born) return '';
  const day = Math.floor((at + (idol.tz ?? 8) * 3600e3 - Date.parse(idol.born + 'T00:00:00Z')) / 86400e3) + 1;
  // the clock too: with none the model guesses the time, and two guesses a minute apart disagree
  const local = new Date(at + (idol.tz ?? 8) * 3600e3), clock = `${local.getUTCHours()}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
  // and which part of the day: told only the clock, an afternoon show still says "这么晚" and "还醒着"
  const h = local.getUTCHours(), part = h < 5 ? '凌晨' : h < 8 ? '早上' : h < 11 ? '上午' : h < 13 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
  const tzName = idol.tzName || ((idol.tz ?? 8) === 8 ? '北京时间' : '当地时间');
  const bits = [`【今天】你作为数字人活到第 ${day} 天，现在是${tzName} ${clock}，${part}。` + (h >= 6 && h < 19 ? '现在是白天，别说“这么晚”“还醒着”“深夜”这类夜里的话。' : '')];
  if (memory) {
    if (e.kind === 'open') {
      if (DAY_MARKS.includes(day) && memory.milestone('day' + day)) bits.push(`今天是你的第 ${day} 天，算个小纪念日，开场提一句你的感受。`);
      const s = memory.score();
      for (const n of [10, 50, 100]) if (s.total >= n && memory.milestone('calls' + n)) { bits.push(`你每天猜涨跌已经出了 ${s.total} 次答案，记录 ${s.right}/${s.total}，可以顺嘴说一句。`); break; }
      bits.push(memory.mindLine());
    }
    if (e.kind === 'idle' && rand() < 0.35 && !/数字人|AI/.test(memory.mindLine())) bits.push(memory.mindLine());
    if (e.kind === 'chat' && !e.worn?.length || (e.kind === 'idle' && !e.worn?.length)) bits.push(memory.stanceLine());
  }
  const out = bits.filter(Boolean).join('\n');
  return out ? '\n' + out : '';
}

// The numbers and chart words she has leaned on in her last lines, so a quiet beat steers her somewhere else (on a
// quiet night a model will say the same price level dozens of times).
const NUM = /(\d{2,3}(?:,\d{3})+|\d{4,6}|[一二三四五六七八九十]万[一二三四五六七八九]?(?:千)?)/g;
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
// 八万二 / 82,000 / 82000 are one number to her listeners
const numKey = x => { const m = x.match(/^([一二三四五六七八九十])万([一二三四五六七八九])?/); return m ? String(CN[m[1]] * 10000 + (m[2] ? CN[m[2]] * 1000 : 0)) : x.replace(/,/g, ''); };
const CHART = ['收盘', '这根', '站住', '站不站', '插针', '偏空', '偏弱', '大饼'];
// Words take the numbers' place once the numbers are kept down, so any two-character word (no little words, no
// numerals) said in 4 of her last lines counts too.
const LITTLE = new Set('我你他她它这那是不了就的个还在有么吗呢啊吧呀哦嘛也都很没看说要会想去来一上下大小多少好点儿得着过和跟把被给让对从到为能可以自己们今天明晚现时候先再又才只真太最其实反正然后但所如果因为啥谁怎样哪里二三四五六七八九十百千万');
const words = t => { const z = String(t).replace(/[^\u4e00-\u9fff]/g, ''); const w = new Set(); for (let i = 0; i < z.length - 1; i++) { const b = z.slice(i, i + 2); if (!LITTLE.has(b[0]) && !LITTLE.has(b[1])) w.add(b); } return w; };
export function wornTopics(said, min = 3) {
  const n = new Map(), wn = new Map();
  for (const t of said) {
    const seen = new Set([...(String(t).match(NUM) || []).map(numKey), ...CHART.filter(w => String(t).includes(w))]);
    for (const k of seen) n.set(k, (n.get(k) || 0) + 1);
    for (const k of words(t)) if (!CHART.some(c => c.includes(k))) wn.set(k, (wn.get(k) || 0) + 1);
  }
  const top = m => [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return [...top(new Map([...n].filter(([, c]) => c >= min))), ...top(new Map([...wn].filter(([, c]) => c >= min + 1)))].slice(0, 6);
}

// What her heart is on about, unless she has already said it twice in her last lines (the heart keeps a thought for a
// long time and the mouth would repeat it every line): that line of the note goes, she has said it.
// Her day (今天 / 今晚想聊) the same way: told twice, it is told.
export function worn(note, said) {
  return String(note || '').split('\n').filter(l => {
    const m = l.match(/^\s*(在想|接下来想|今天|今晚想聊)[:：]\s*(.+)$/);
    if (!m) return true;
    const bits = m[2].split(/[，,；;、。！？\s]+|加|和|跟|还是|然后/).map(b => b.replace(/^(想|吃|再|先|继续|去|有点)/, '')).filter(b => b.length >= 2).map(b => b.slice(0, 2));
    return !bits.some(b => said.filter(t => String(t).includes(b)).length >= 2);
  }).join('\n').trim();
}

// Quiet is not empty: the comment reader can be stuck while thousands are watching, and a host saying "就我一个人"
// all night sends them away. Nobody typing is all she knows.
const QUIET_NOTE = '没人打字不等于没人看：别说“没人”“就我一个”“一个人在这儿”“没人吭声”“没人理我”这种话，也别数冷场了多少分钟。';
// The same goes for replies, unless the comment itself asks about it.
export const wornReply = (e, worn) => {
  if (!worn?.length || !['chat', 'join', 'thanks', 'request'].includes(e.kind)) return '';
  const asked = [e.text, ...(e.also || []).map(a => a.text)].join(' ');
  const keep = worn.filter(k => !wornTopics([asked, asked, asked]).includes(k) && !asked.includes(k));
  return keep.length ? `\n你今晚已经反复说过：${keep.join('、')}。这次回他别再提这几个数和词，他没问就不说你盯的那条线，聊他说的事。` : '';
};
const wornLine = e => (e.worn?.length ? `你刚才已经反复说过：${e.worn.join('、')}。这次换个完全不同的话题（广场上刷到的、今天自己身上的事、粉丝说过的话、别的币），这几个数和词这次一个都别提。` : '');

// What she is told about each event. Kept short: the model is good at filling in attitude.
// The other comments that came in at the same time (next() folds them in): she sees the whole chat, picks.
const alsoLine = e => e.also?.length ? `\n同一时间弹幕里还有：${e.also.map(a => `${a.name}：${a.text}`).join('；')}。你可以一起回、挑一两条回，其他的点个名或者不接。` : '';
export function promptFor(idol, e) {
  const hook = () => `（这次的套路：${pick(idol.hooks)}。用你自己的话，40 字以内，别照抄例子。）`;
  switch (e.kind) {
    case 'chat': return { text: `【弹幕 by ${e.name || tail(e.addr)}】${e.text}${alsoLine(e)}${langLine(e.text)}${NOTE_ASK}` };
    case 'request': return { text: `【点播】${e.name || tail(e.addr)} 点你做「${e.action}」。动作标签必须写[${e.action}]，一边做一边回他一句，30 字以内。` };
    case 'market': return { text: `【行情异动】${e.coin} 这 ${e.minutes} 分钟${e.pct > 0 ? '突然拉了' : '突然砸了'} ${Math.abs(e.pct).toFixed(1)}%，现在 ${e.price} 美元左右。第一时间反应一下，像看盘时脱口而出那样，可以说你觉得还会不会接着走。40 字以内。` };
    // A quiet room is her cue, not a rest: telling her she may stay silent leaves minutes of dead air and lines like
    // "就这么干耗着" that send newcomers away, and Square shuts streams that go quiet.
    case 'idle': if (!idol.hooks) return { text: `【冷场】直播间${e.quietMin >= 2 ? '有一阵子没人打字了' : '安静了一会儿'}${e.viewers > 1 ? `，${e.viewers} 个人在看。${QUIET_NOTE}` : e.viewers === 1 ? `，有人在看，只是没人打字。${QUIET_NOTE}` : '，这会儿直播间里一个人都没有，你自己播着，刷到的人随时会进来。'}${wornLine(e)}冷场是你最会来事的时候：别干等，别抱怨没人说话（“干耗着”“念出回声”“没人理我”“好困”这种不说），也别求人冒泡。挑一样起一段，用你自己的方式：接着前面谁说过的一句话往下聊（只点刚才直播间里真说过话的人，别叫没出现的人）；讲一件今天真发生的事；对盘押个看法，叫大家一起盯这根收盘；对着盘现编两句小调；吐槽一件今天身边的小事。你心里“接下来想”有打算的，就做那个。只讲真发生过的事，押的是看法，没下单就不说成下了单。${e.mustTalk ? '这次要开口说。' : '也可以就安静着只做个动作（台词留空，只写标签）。'}` };
      return { text: `【系统】直播间安静了一会儿，${e.viewers} 个人在看你直播。${idol.idleNote || '像主播一样把场子热起来'}。${hook()}` };
    case 'news': return { text: `【刚看到的快讯】${e.item.title}${e.item.sub ? '：' + e.item.sub : ''}
直播间安静了一会儿，你刷到这条，用自己的话跟大家八卦一下：只挑最有意思的一个点说，最多带一个数字，别念一串数据，别念原文、别说出处；项目名照原样说，别翻译；时间日期照快讯说，拿不准就不说。说完加一句你的看法或吐槽。50 字以内。` };
    case 'learned': return { text: `【你刚刷推特看到的】${e.item.who ? '@' + e.item.who + ' 那边：' : ''}${e.item.what}${e.item.term ? `（新词：${e.item.term}）` : ''}
直播间安静了一会儿，你一边直播一边刷推特，刚刷到这个，像刚看到新鲜事那样跟大家说，有新词就现学现卖用一下。不说合约地址。60 字以内。` };
    // Like anyone, she hears what happened today (today.mjs: Douyin, US trends, X, Square) and brings it up.
    case 'today': return { text: `【你今天刷手机看到的】${e.item.from ? '（' + e.item.from + '）' : ''}${e.item.what}${e.item.why ? '——' + e.item.why : ''}
直播间安静了一会儿，你像个普通人跟朋友聊今天刷到的新鲜事那样说起这个：先说是啥事，再说你自己的看法或吐槽，能扯到币圈或你自己身上更好，可以问问大家看到没有。别说“据报道”，别念标题。50 字以内。` };
    // What Binance is promoting lately (pushes.mjs): her own real use, told like a friend's tip, never an ad
    case 'push': return { text: `【币安最近在推的】${e.item.name}：${e.item.what}${e.item.how ? `\n普通人怎么开始：${e.item.how}` : ''}
你自己：${e.item.used ? (e.item.mine || '你在用，具体感受还没写下来') : '你还没用过'}
直播间安静了一会儿，你想起币安最近在推这个，跟大家聊两句：${e.item.used ? '讲你自己真用它的经过和感觉（只讲上面写着的，没写的别编），再顺手教一句不会的人怎么开始（说 App 里点哪里，不念网址）' : '照实说你还没用过，看到币安在推、打算试试，问问直播间有没有人用过、好不好用'}。像跟朋友安利，不像念广告；你是用户，不说“我们币安”；不说“刚好有人问我”。70 字以内。` };
    case 'post': return { text: `【你刚刷广场看到的】${e.item.who} 发了一条（${e.item.comments} 条评论）：${e.item.text}\n直播间安静了一会儿，你一边直播一边刷币安广场，刷到这条。像主播刷到好玩的帖子那样：说一下是谁发的、他说了啥，再接一句你的反应或吐槽，可以问问直播间的人怎么看。不念链接。50 字以内。` };
    case 'segment': return { text: e.text };
    case 'self': return { text: `【你自己】${e.quietMin >= 2 ? `有一阵子没人打字了` : '直播间安静着'}。${e.viewers === 0 ? '' : QUIET_NOTE}${wornLine(e)}这一句不是说给观众听的，是你自己此刻的状态：你在干嘛、在想什么、什么感觉，像一个人待着时的自言自语，可以就是一声叹气、哼两句、嘟囔一句。不找话题，不提问，不招呼人。20 字以内。` };
    case 'more': return { text: `【接着聊】直播间还是没人打字。${wornLine(e)}你刚才说的是：「${e.last}」\n别换话题，接着这个往下说：补一个细节、想起相关的一件事、自己反驳自己（“不对不对……”）、或者冲直播间问一个很具体的问题。也可以就是一句自言自语。别重复刚才那句的意思。` };
    case 'thanks': {
      const who = e.names?.length ? e.names.join('、') : '有人';
      if (e.act === 'follow') return { text: `【关注】${who} 刚关注了你。像主播被关注时那样随口谢一声，可以顺嘴逗一句。30 字以内。` };
      const what = e.act === 'red' ? '发了一个红包' : e.act === 'tip' ? `给你打赏了${e.what ? ' ' + e.what : ''}` : `送了你${e.what ? '「' + e.what + '」' : '一个礼物'}`;
      return { text: `【礼物】${who} ${what}。像收到礼物的主播那样谢他${e.say ? '，' + e.say : ''}，可以得意一下，别报价钱。30 字以内。` };
    }
    case 'join': if (e.regulars?.length) return { text: `【直播间】${e.names.join('、')} 刚进来，现在 ${e.viewers} 个人在看。${e.regulars.join('、')} 是你认识的老朋友，又来了：这句就冲他说，像真看见熟人那样，用他平时的叫法（有姓的叫“X哥/X姐”，名字长的取前两个字，别念全名、别现编外号），接上一件你记得的他的事（问后来怎么样了），一句话，口语。其他人不用提。别说“欢迎回来”“进来坐”“晚上好”这种迎宾话。` };
      return { text: `【直播间】${e.names?.length ? e.names.join('、') + ' 刚进来' : '刚有人进来'}，现在 ${e.viewers} 个人在看。不用专门欢迎：多半接着说你自己刚才的事，顺带叫他一声就行（像朋友那样叫，别念全名：有姓的叫“X哥/X姐”，一串字母数字的叫“好兄弟”“厚米”或现编个外号），也可以不提；别拿他的名字开玩笑（一晚上反复说“你这名字……”很快就腻）；别说“进来坐”“欢迎欢迎”“晚上好”这种迎宾话。` };
    case 'open': return { text: `【开播】你刚开播，${e.viewers} 个人在等你。跟大家打招呼，说说今天要干嘛。60 字以内。` };
    case 'close': return { text: `【下播】今天的直播时间到了，跟大家道别，告诉他们下次开播时间是${e.next}。60 字以内。` };
    case 'diaryNote': return { text: `【系统】你刚写完今天的日记，跟大家说一声，透露一点点内容吊胃口。日记开头：${e.preview}` };
  }
  return { text: '【系统】随便说一句。' };
}

// Swearing stays mild; anything ruder the model slips in is taken out.
export const tame = t => String(t).replace(/他妈的?|妈的|操你|草泥马|傻[逼比屄]|[逼屄]/g, '');

// Cut an overlong speech or diary back to the last full sentence that fits (never mid-sentence).
export function fitLength(text, max = 300) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max), end = Math.max(...['。', '！', '？', '…', '\n'].map(c => cut.lastIndexOf(c)));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut).trim();
}

// "[开心][飞吻]台词": first tag a face, second an action from the idol's list ([无] or unknown = no action). An idol with
// voice tones adds a third tag, how the line is read: "[开心][无][吐槽]台词".
export function parseReply(idol, raw) {
  let text = String(raw || '').trim().replace(/^["“]|["”]$/g, '');
  let face = 'neutral', action = null, tone = null;
  const tones = tonesOf(idol);
  for (let i = 0; i < 3; i++) {
    const m = text.match(/^[\[【]\s*([^\]】]{1,4})\s*[\]】]\s*/);
    if (!m) break;
    if (FACES[m[1]]) face = FACES[m[1]];
    else if (idol.actions[m[1]]) action = m[1];
    else if (tones[m[1]]) tone = m[1];
    text = text.slice(m[0].length);
  }
  // The format example's placeholder copied literally ("尾号xxxx 大家晚上好") is dropped.
  text = scrub(text.replace(/[\[【][^\]】]{1,6}[\]】]/g, '').replace(/[（(][^）)]{0,20}[）)]/g, '').replace(/(尾号|游客)\s*[xX＊*]{4}[，,、\s]*/g, '')).trim();
  return { face, action, text, ...(tone ? { tone } : {}) };
}

// The action she does when the model didn't choose one: a wave for a walk-in, a heart for a gift, and so on.
// A list is a choice (one fixed move per event makes every greeting the same wave).
export function defaultAction(idol, e, rand = Math.random) {
  const one = a => (Array.isArray(a) ? a[Math.floor(rand() * a.length)] : a);
  return one(idol.react[e.kind] ?? idol.kindAction?.[e.kind] ?? null);
}

// The face her own feeling asks for (the model tags most lines 平静 even when it wrote 想笑, 来劲 or 有点烦 for
// herself): when the line's tag says 平静 but the 想 line says something else, the feeling wins.
const FEEL_FACE = [['angry', /生气|气死|火大|恼火|不爽|憋屈/], ['sad', /难过|伤心|失落|委屈|低落|丧|心疼|难受|心酸/], ['shy', /害羞|不好意思|脸红|羞/], ['smug', /得意|嘚瑟|骄傲|小傲娇|臭美/], ['happy', /开心|高兴|想笑|好笑|乐|来劲|兴奋|甜|美滋滋|爽/]];
export function faceOfFeel(feel) {
  const f = String(feel || '');
  if (/不(太|怎么|是很|够)?(开心|高兴)|没(那么|什么|多)?(开心|高兴)/.test(f)) return 'sad';
  for (const [face, re] of FEEL_FACE) if (re.test(f)) return face;
  return null;
}

// The finer feeling inside a line's face (idol.shades): what she wrote after 想, else the line's tone when the
// face is calm. Picks the moves, not the voice. null = the face's own moves.
export function shadeOf(idol, line, feel) {
  if (!idol.shades) return null;
  const f = String(feel || '');
  if (f) for (const [k, [re]] of Object.entries(idol.shades)) if (re.test(f)) return k;
  return line.face === 'neutral' ? idol.toneShade?.[line.tone] ?? null : null;
}
const movesOf = (idol, line) => (line.shade && idol.shades?.[line.shade]?.[1]) || idol.moods[line.face] || idol.moods.neutral;

// The move that goes with a line: face, hands and voice say the same thing. The model's move stays when it
// fits the line's mood (or is a cute pose on a happy, shy or smug line); otherwise the event's own move (phone for a
// post, screen for the board), otherwise one from the mood's list. Idols without `moods` keep the model's choice.
const CUTE_OK = new Set(['happy', 'shy', 'smug']);
// Small, varied faces instead of stock poses: never the same move twice running when the mood has others.
// `last` may be the last few moves; none of them comes back while the pool has others.
export function moveFor(idol, line, e, rand = Math.random, last = null) {
  if (e.kind === 'request') return e.action;
  if (!idol.moods) return line.action || defaultAction(idol, e);
  const recent = [].concat(last ?? []);
  const all = movesOf(idol, line).filter(a => idol.actions[a] && !idol.actions[a].quiet);
  const fresh = all.filter(a => !recent.includes(a)), pool = fresh.length ? fresh : all.filter(a => a !== recent.at(-1));
  const a = line.action, def = idol.actions[a];
  const fits = pool.includes(a) || (idol.moods[line.face] || []).includes(a) && !recent.includes(a);
  if (a && !recent.includes(a) && def && (fits || (!def.daily && CUTE_OK.has(line.face)))) return a;
  const kind = defaultAction(idol, e, rand);
  if (kind) return kind;
  return pool.length ? pool[Math.floor(rand() * pool.length)] : null;
}

// The second, smaller face partway through a long line (avatar.mjs beat): a 微表情 of the same mood, not the line's move.
// A thin shade (only two small faces) would repeat one face all night, so it borrows its mood's small faces, and her
// last few never come straight back.
export function beatFor(idol, line, rand = Math.random, recent = []) {
  if (!idol.moods || !line.text) return null;
  const micro = a => idol.actions[a]?.micro && !idol.actions[a].quiet && a !== line.action;
  let pool = movesOf(idol, line).filter(micro);
  if (pool.length < 3) pool = [...new Set([...pool, ...(idol.moods[line.face] || idol.moods.neutral).filter(micro)])];
  const fresh = pool.filter(a => !recent.includes(a));
  if (fresh.length) pool = fresh;
  return pool.length ? pool[Math.floor(rand() * pool.length)] : null;
}

export function openrouter({ key, model = MODEL, fetchImpl = fetch, title = 'livehost' }) {
  return async function ask(messages, { long = false, signal } = {}) {
    const r = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': title },
      body: JSON.stringify({ model, messages, reasoning: { enabled: false }, temperature: 0.9, max_tokens: long ? 600 : 160, usage: { include: true } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`openrouter ${r.status}: ${j.error?.message || ''}`.slice(0, 160));
    return { text: j.choices?.[0]?.message?.content || '', cost: j.usage?.cost || 0 };
  };
}

// DeepSeek's own API: thinking off, temperature 1.0 (1.3 came apart late in long chats). cost is an estimate from the
// token counts (price: USD per 1M, rough).
export function deepseek({ key, model = 'deepseek-flash', temperature = 1.0, fetchImpl = fetch, base = 'https://api.deepseek.com', price = { hit: 0.07, miss: 0.56, out: 1.68 } }) {
  return async function ask(messages, { long = false, signal } = {}) {
    let r;
    try {
      r = await fetchImpl(`${base}/chat/completions`, { method: 'POST', signal, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature, thinking: { type: 'disabled' }, max_tokens: long ? 600 : 200 }) });
    } catch (err) { throw new Error(`deepseek: ${String(err?.message || err).split(key).join('***')}`.slice(0, 160)); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`deepseek ${r.status}: ${String(j.error?.message || '').split(key).join('***')}`.slice(0, 160));
    const u = j.usage || {}, hit = u.prompt_cache_hit_tokens || 0, miss = u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens || 0) - hit);
    return { text: j.choices?.[0]?.message?.content || '', cost: (hit * price.hit + miss * price.miss + (u.completion_tokens || 0) * price.out) / 1e6 };
  };
}

// What happened, said as a fact, for the direct mouth. Kinds not listed keep promptFor's text, minus the
// "N 字以内" (how long she talks is hers).
export function factFor(idol, e, w) {
  const who = e.name || (e.addr ? tail(e.addr) : '有人');
  const v = e.viewers > 1 ? `，${e.viewers} 个人在看` : e.viewers === 1 ? '，有一个人在看' : '，这会儿没人在看';
  switch (e.kind) {
    case 'chat': return `【弹幕】${who}：${e.text}${e.also?.length ? '\n' + e.also.map(a => `【弹幕】${a.name}：${a.text}`).join('\n') : ''}${langLine(e.text)}${NOTE_ASK}`;
    case 'request': return `【点播】${who} 点你做「${e.action}」（动作标签写 [${e.action}]）。`;
    case 'join': return `【直播间】${e.names?.length ? e.names.join('、') + ' 刚进来' : '刚有人进来'}。${e.regulars?.length ? `${e.regulars.join('、')} 是你认识的老朋友。` : ''}`;
    case 'thanks': {
      const names = e.names?.length ? e.names.join('、') : '有人';
      if (e.act === 'follow') return `【关注】${names} 刚关注了你。`;
      return `【礼物】${names} ${e.act === 'red' ? '发了一个红包' : e.act === 'tip' ? `给你打赏了${e.what ? ' ' + e.what : ''}` : `送了你${e.what ? '「' + e.what + '」' : '一个礼物'}`}。`;
    }
    case 'idle': return `【直播间】${e.quietMin >= 2 ? '有一阵子没人打字了' : '安静了一会儿'}，有人在看。`;
    case 'self': return '【直播间】安静着，这会儿你自己待着。';
    case 'more': return `【直播间】还是没人打字。你刚才说到：「${e.last}」`;
    case 'open': return `【开播】你刚开播${v}。`;
    case 'close': return `【下播】今天的直播时间到了，下次开播是${e.next}。`;
    case 'market': return `【行情】${e.coin} 这 ${e.minutes} 分钟${e.pct > 0 ? '突然拉了' : '突然砸了'} ${Math.abs(e.pct).toFixed(1)}%，现在 ${e.price} 美元左右。`;
    case 'news': return `【你刚刷到的快讯】${e.item.title}${e.item.sub ? '：' + e.item.sub : ''}`;
    case 'learned': return `【你刚刷推特看到的】${e.item.who ? '@' + e.item.who + ' 那边：' : ''}${e.item.what}${e.item.term ? `（新词：${e.item.term}）` : ''}`;
    case 'today': return `【你今天刷手机看到的】${e.item.from ? '（' + e.item.from + '）' : ''}${e.item.what}${e.item.why ? '——' + e.item.why : ''}`;
    case 'post': return `【你刚刷广场看到的】${e.item.who} 发了一条（${e.item.comments} 条评论）：${e.item.text}`;
    case 'push': return `【币安最近在推的】${e.item.name}：${e.item.what}${e.item.how ? `\n普通人怎么开始：${e.item.how}` : ''}\n你自己：${e.item.used ? (e.item.mine || '你在用，具体感受还没写下来') : '你还没用过'}`;
  }
  return promptFor(idol, e, w).text.replace(/[，,]?\s*\d+\s*(到\s*\d+\s*)?字以内[。]?/g, '。').replace(/。。/g, '。');
}

// Main model with a backup. The model that talks most like a person is often not the fastest, and now and then it
// answers nothing; past mainMs, or on an error or an empty answer, the backup says the line instead, so the room never
// sits in silence.
export function withBackup(main, backup, { mainMs = 6500, longMainMs = 20000, log = console.log } = {}) {
  return async function ask(messages, opts = {}) {
    const own = new AbortController();
    const t = setTimeout(() => own.abort('slow'), opts.long ? longMainMs : mainMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, own.signal]) : own.signal;
    try {
      const r = await main(messages, { ...opts, signal });
      if (String(r.text || '').trim()) return r;
      log('main model answered nothing, backup speaks');
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      log(`main model ${own.signal.aborted ? 'too slow' : 'failed (' + String(e.message || e).slice(0, 80) + ')'}, backup speaks`);
    } finally { clearTimeout(t); }
    return backup(messages, opts);
  };
}

// The queue and the loop. `speak(line, event)` performs one line and resolves when it has been seen and heard.
// `onAir()` false = off the schedule: she stays quiet, chat events wait (and go stale) instead of being voiced.
export function createBrain({ idol, world, ask, speak, direct: directOn = false, memory = null, memes = null, news = null, learned = null, posts = null, today = null, pushes = null, rand = Math.random, viewers = () => 1, onAir = () => true, market = null, now = () => Date.now(), timeoutMs = 12000, longTimeoutMs = 30000, idleMs = 75000, joinGapMs = 45000, status, act = null, alone = () => false, heart = () => '', pageOf = () => '' }) {
  const takeInnerOn = !!idol.inner;
  // what her heart (heart.mjs) last noted: her mood, why, what she is on about, how she feels about the people here
  const heartLine = (n, e) => { n = n && worn(n, (world.w.talk || []).slice(0, 10).map(t => t.text)); if (n && e?.worn?.length) n = n.split('\n').filter(l => !/^\s*盘上[:：]/.test(l) || !wornTopics([l, l, l]).some(k => e.worn.includes(k))).join('\n'); return n ? `\n【你此刻心里（只有你自己知道，不要念出来，让它决定你说话的味道）】\n${n}` : ''; };
  let queue = [], running = false, current = null, lastSpoke = now(), lastTalked = now(), wake = null, lastHeard = now();   // lastHeard: last comment or 点播
  let loopPromise = null;
  const spend = { usd: 0, calls: 0, fails: 0 };
  const persona = personaOf(idol);
  // her mouth when the heart is on: who she is in two lines, real hosts' lines, the same reply format
  const mouthText = idol.mouth ? personaOf(idol, idol.mouth.persona + '\n\n' + idol.persona.slice(Math.max(0, idol.persona.indexOf('回复格式：')))) : null;
  const personaFor = note => (mouthText && note ? mouthText : persona);
  // the real hosts' lines go last, right before the line is asked for, where the model listens most
  const examplesFor = (e, note) => (mouthText && note ? idol.mouth.examples?.(e, rand) ?? '' : '');
  // words that turn into a tic (a pet word in every few lines): said in her last lines, not again this time
  const ticsFor = () => {
    const said = (world.w.talk || []).slice(0, 15).map(t => t.text).join('\n') + (world.w.recent || []).slice(0, 8).join('\n');
    const hit = (idol.mouth?.tics || []).filter(t => said.includes(t));
    return hit.length ? `\n这几个词你刚才说过，这次别再说：${hit.join('、')}。` : '';
  };
  let lastMove = [], lastBeats = [];
  const took = a => { if (a) lastMove = [...lastMove, a].slice(-3); return a; };   // her last three moves (moveFor)
  // Her mood through the show: set by the line she writes for herself, carried until something moves it,
  // handed to the night's reflection, and the last show's closing mood opens the next one.
  let mood = null;
  function moodLine(e) {
    if (!takeInnerOn) return '';
    if (mood) return `\n【你此刻的心情】${mood.feel}（${Math.max(0, Math.round((now() - mood.at) / 60e3))} 分钟了${mood.why ? '，' + mood.why : ''}）。心情是连着的：没发生真戳到你的事，就带着它接着说。`;
    return '';
  }
  function lifeFor(e) {
    if (!memory?.lifeLine) return '';
    const bits = [memory.lifeLine(e.kind === 'open' ? 6 : 4)];
    if (['open', 'idle', 'self', 'more'].includes(e.kind)) bits.push(memory.goalLine());
    const out = bits.filter(Boolean).join('\n');
    return out ? '\n' + out : '';
  }
  const priorityOf = e => PRI[e.kind] ?? 10;
  function enqueue(item) {
    queue.push(item);
    return item;
  }

  function add(e) {
    if (e.kind === 'join') { greet(e); wake?.(); return; }
    // several follows (or gifts) in a row are thanked in one line
    const same = e.kind === 'thanks' && queue.find(q => q.kind === 'thanks' && q.act === e.act && q !== current?.e);
    if (same) { if (e.name && !same.names.includes(e.name)) same.names.push(e.name); return; }
    if (e.kind === 'thanks') e = { ...e, names: e.name ? [e.name] : [] };
    if (e.kind === 'chat' || e.kind === 'request') lastHeard = now();
    const item = enqueue({ ...e, at: now(), pri: priorityOf(e) });
    if (queue.length > 30) { queue.sort((a, b) => b.pri - a.pri); queue.length = 30; }
    // Something much bigger than what she is waiting on cuts the wait short (never a line already being performed).
    if (current && !current.speaking && item.pri >= current.e.pri + 30) current.abort.abort('preempted');
    wake?.();
  }

  // Off air only the goodbye may still be said; everything else waits (and goes stale).
  function next(live) {
    const t = now();
    queue = queue.filter(q => !(STALE_MS[q.kind] && t - q.at > STALE_MS[q.kind]));
    const ok = queue.filter(q => live || q.kind === 'close');
    if (!ok.length) return null;
    // a waiting comment climbs a point a second, so nobody waits minutes while later comments get answers
    const eff = q => q.pri + (q.kind === 'chat' ? Math.min(30, (t - q.at) / 1000) : 0);
    ok.sort((a, b) => eff(b) - eff(a) || a.at - b.at);
    queue = queue.filter(q => q !== ok[0]);
    // Comments waiting together are read together: a real host takes in the chat as a whole, answers one or two
    // and nods at the rest, instead of working through it one by one while the others wait a whole line each.
    if (ok[0].kind === 'chat') {
      const also = queue.filter(q => q.kind === 'chat').sort((a, b) => a.at - b.at).slice(0, 3);
      if (also.length) { queue = queue.filter(q => !also.includes(q)); return { ...ok[0], also: also.map(q => ({ name: q.name || tail(q.addr), text: q.text, q })) }; }
    }
    return ok[0];
  }

  async function think(e) {
    // a regular among the names walking in turns the greeting from "no need to welcome" into "recognise him"
    if (e.kind === 'join' && e.names?.length && memory?.regulars) e.regulars = memory.regulars(e.names, n => !!pageOf(n)).slice(0, 2);
    if (!e.worn) e.worn = wornTopics((world.w.talk || []).slice(0, 20).map(t => t.text));
    const direct = !!(directOn && idol.mouth?.direct && heart?.());   // facts, not rules (factFor, idol.mouth.direct)
    const p = promptFor(idol, e, world.w);
    if (direct) p.text = factFor(idol, e, world.w);
    else p.text += wornReply(e, e.worn);
    if (e.skipped && direct) p.text += `\n（${e.name || '他'}这条等了一会儿了）`;
    else if (e.skipped) p.text += `\n（${e.name || '他'}这条刚才弹幕太多没顾上，等了一会儿了：先叫他名字，直接回他说的事，别道歉太多。）`;
    if (e.kind === 'open') { memes?.forget(); showAt = now(); segDone.clear(); mood = null; }
    const mo = memes && !p.long ? memes.offer(e, { bare: !!(mouthText && heart?.()) }) : null;
    if (mo) p.text += mo.text;
    // when several comments wait, keep it short (long answers in a busy room leave most comments unanswered)
    const busy = e.kind === 'chat' && (e.also?.length || 0) + queue.filter(q => q.kind === 'chat').length >= 2;
    if (!p.long && idol.lengths && !direct) p.text = p.text.replace(/，?\s*\d+ 字以内(?=[，。）]|$)/g, '').replace(/。。/g, '。') + `\n（这次的长度：${busy ? idol.lengths.say[0] + '，最多一句（弹幕在排队）' : pickLength(idol.lengths, e, rand)}）`;
    const asksCall = (e.kind === 'open' || e.kind === 'idle') && market?.fresh && memory && !memory.calledToday();
    // she owns up to yesterday's call at the next opening, before today's new one
    const owe = e.kind === 'open' && memory?.unowned?.();
    if (owe) p.text += `\n先认账：你上次立的看盘是「${owe.say}」，结果${owe.result}，你${owe.right ? '说对了，可以小小得意一句，别太嚣张' : '说错了，大方认，自嘲一句，别找借口'}。开场先说这个，再说今天。` + (memory.score().total >= 3 ? `看盘记录现在 ${memory.score().right}/${memory.score().total}。` : '');
    if (asksCall) p.text = (e.kind === 'idle' ? `【系统】直播间安静了一会儿，${e.viewers} 个人在看。你今天还没立看盘，现在跟大家立一个，60 字以内。` : p.text) + CALL_ASK;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort('timeout'), p.long ? longTimeoutMs : timeoutMs);
    current = { e, abort, speaking: false };
    let line;
    try {
      const note = heart?.();
      const messages = direct ? [{ role: 'system', content: personaOf(idol, typeof idol.mouth.direct === 'function' ? idol.mouth.direct(rand) : idol.mouth.direct) + `\n\n画面里的你：${idol.stages[0].look}。` + (market ? market.lineFor(e) : '') + memoryFor(memory, e, rand, pageOf) + roomFor(world.w, e, now()).replace(/\n接着上面的聊[^\n]*$/, '') + soulFor(idol, memory, e, now(), rand) + lifeFor(e) + moodLine(e) + heartLine(note, e) }, { role: 'user', content: p.text }]
        : [{ role: 'system', content: personaFor(note) + '\n' + contextFor(idol) + (market ? market.lineFor(e) : '') + memoryFor(memory, e, rand, pageOf) + (['chat', 'request', 'idle'].includes(e.kind) ? roomFor(world.w, e, now()) : '') + soulFor(idol, memory, e, now(), rand) + lifeFor(e) + moodLine(e) + heartLine(note, e) + examplesFor(e, note) + ticsFor() + waitingFor(world.w, now()) + (p.long ? '\n这次是长段感言，150 到 250 字，宁短勿长，可以分几句。' : '\n每次只说一段话，60 字以内（英文 40 词以内）。') }, { role: 'user', content: p.text + recentFor(world.w) }];
      let r = await ask(messages, { long: p.long, signal: abort.signal });
      if (abort.signal.reason === 'stopped') return null;
      spend.usd += r.cost; spend.calls++;
      let inner = takeInner(r.text); r = { ...r, text: inner.text };
      // Saying the same thing as a few lines ago is what makes her sound like a bot; one rewrite when it happens.
      const again = !p.long && repeatOf(r.text, world.w.recent.slice(0, 12));
      if (again) {
        messages[1].content += `\n\n这句跟你刚说过的话重复了（「${again}」）。换一个完全不同的说法：不同的开头、不同的结尾、不同的意思角度。`;
        try { const r2 = await ask(messages, { long: p.long, signal: abort.signal }); spend.usd += r2.cost; spend.calls++; inner = takeInner(r2.text); r = { ...r2, text: inner.text }; } catch {}
        console.log(`repeat "${again}" rewritten${repeatOf(r.text, world.w.recent.slice(0, 12)) ? ', still repeats' : ''}`);
      }
      if (abort.signal.reason === 'stopped') return null;
      const sg = takeSong(r.text);
      const bet = takeCall(sg.text);
      if (asksCall && bet.call) {
        const c = market.get(bet.call.coin);
        // Only a call she actually said out loud goes in the book (the tag alone once came with an unrelated line).
        if (c && market.mentioned(bet.text).includes(c.coin)) memory.call({ subject: c.coin, say: `${c.coin} 明天这个时候会${bet.call.dir === 'up' ? '比现在高' : '比现在低'}`, dir: bet.call.dir, price: c.price, due: now() + 23 * 3600e3 });
      }
      const jot = takeNote(bet.text);
      if (memory && e.name) { if (jot.note) memory.note(e.name, jot.note); if (e.kind === 'chat') memory.topic(e.name, e.text); }
      line = parseReply(idol, jot.text);
      if (owe && line.text) memory.owned(owe);
      if (line.face === 'neutral' && faceOfFeel(inner.feel)) line.face = faceOfFeel(inner.feel);
      line.shade = shadeOf(idol, line, inner.feel);
      if (inner.feel) mood = mood?.feel === inner.feel ? { ...mood, why: inner.why || mood.why } : { feel: inner.feel, why: inner.why, at: now() };
      if (inner.inner) line.inner = inner.inner;
      // A quiet room may get no words at all: she just does something (she chooses).
      if (!line.text && QUIET.includes(e.kind) && !e.mustTalk && act) { line.silent = true; line.action = took(moveFor(idol, line, e, rand, lastMove)); line.source = 'model'; status?.('model', true); return line; }
      if (!line.text) throw new Error('empty reply');
      if (mo) { memes.took(mo, line.text); if (mo.songs.length) line.bgm = memes.song(mo.songs[0].id); }
      if (p.long) line.text = fitLength(line.text, 320);
      status?.('model', true);
      line.source = 'model';
    } catch (err) {
      if (abort.signal.reason === 'preempted' || abort.signal.reason === 'stopped') return null;
      spend.fails++;
      const why = String(err.message || err).slice(0, 120);
      status?.('model', false, why);
      console.warn(`model failed (${e.kind}): ${why}`);   // journal keeps the reason; health only shows the latest
      line = { ...parseReply(idol, pick(idol.fallback[e.kind] || idol.fallback.idle)), source: 'fallback' };
    } finally { clearTimeout(timer); }
    line.shade ??= shadeOf(idol, line);
    line.action = took(moveFor(idol, line, e, rand, lastMove));   // a 点播 is always done, whatever the model wrote
    line.beat = beatFor(idol, line, rand, lastBeats);
    if (line.beat) lastBeats = [...lastBeats, line.beat].slice(-4);
    return line;
  }

  // Someone new walking in gets greeted, at most once per joinGapMs so a crowd arriving isn't one greeting each.
  // Square says who walked in (add({ kind: 'join', name })): names fold into the greeting still waiting
  // (three at most), and a named arrival and the count going up are the same greeting.
  let seen = 0, lastGreet = 0;
  function greet({ name = '', viewers: v = viewers() } = {}) {
    const waiting = queue.find(q => q.kind === 'join');
    if (waiting) { if (name && !waiting.names.includes(name)) waiting.names = [...waiting.names, name].slice(-3); waiting.viewers = Math.max(waiting.viewers, v); return; }
    if (now() - lastGreet <= (idol.greetGapMs ?? joinGapMs)) return;
    lastGreet = now();
    enqueue({ kind: 'join', names: name ? [name] : [], viewers: v, pri: PRI.join, at: now() });
  }
  function noticeJoin() {
    const v = viewers();
    if (v > seen) greet({ viewers: v });
    seen = v;
  }

  // A quiet room gets something to talk about: the show's fixed segments when their minute
  // comes, else now and then a news item or something she learned on X, else the plain idle hooks.
  let showAt = null, thread = 0;
  const segDone = new Set();
  function idleEvent() {
    // maxQuietMs: after that long without a spoken line the next quiet beat must say something.
    const worn = wornTopics((world.w.talk || []).slice(0, 20).map(t => t.text));
    const base = { viewers: viewers(), pri: PRI.idle, at: now(), quietMin: Math.round((now() - lastHeard) / 60e3), mustTalk: now() - lastTalked >= (idol.maxQuietMs ?? Infinity), worn };
    const min = showAt == null ? 0 : (now() - showAt) / 60e3;
    const seg = (idol.segments || []).find(s => !segDone.has(s.key) && min >= s.atMin && min < s.atMin + 25);
    if (seg) { segDone.add(seg.key); return { ...base, kind: 'segment', key: seg.key, text: seg.text.replace('{losses}', () => lossesLine()) }; }
    // Like a real streamer between comments: scroll Square, X, the news; the persona's own hooks the rest of the time.
    // A real host stays on a topic for a few lines before moving on, or it does not sound like a person talking.
    const last = world.w.line;
    // a worn topic is not carried on, or "接着聊" keeps her on one price level for hours
    if (last?.text && !worn.length && !['close', 'join', 'open'].includes(last.kind) && now() - (last.at || 0) < 4 * 60e3 && thread < 2 && rand() < 0.5) { thread++; return { ...base, kind: 'more', last: last.text.slice(0, 120) }; }
    thread = 0;
    if (idol.idleSelf && rand() < idol.idleSelf) return { ...base, kind: 'self', quietMin: Math.round((now() - lastHeard) / 60e3) };
    // what Binance is pushing: at most twice a show, spaced out (pushes.mjs decides when)
    const push = pushes?.pick(showAt);
    if (push) return { ...base, kind: 'push', item: push };
    // worn: always try something new from Square / X / the news / today's hot list first, in a random order
    const order = worn.length ? ['post', 'learned', 'news', 'today'].sort(() => rand() - 0.5) : [(r => (r < 0.2 ? 'post' : r < 0.4 ? 'learned' : r < 0.65 ? 'news' : r < 0.8 ? 'today' : null))(rand())];
    for (const kind of order) {
      const item = kind && { post: posts, learned, news, today }[kind]?.pick();
      if (item) return { ...base, kind, item };
    }
    return { ...base, kind: 'idle' };
  }
  function lossesLine() {
    const sad = world.w.chat.filter(c => showAt != null && c.at >= showAt && LOSS.test(c.text)).slice(-6);
    if (!sad.length) return '今晚评论里没人报惨，你就说今晚大家都太稳了，这个奖只好颁给你自己，自嘲一下。50 字以内。';
    return `今晚评论里报过惨的：${sad.map(c => `${c.who}：${c.text}`).join('；')}。挑一个颁给他，叫他的名字，拿他开个玩笑但要接得住他。50 字以内。`;
  }

  // she named someone if a piece of the name shows up in what she said ("熊猫大帝" for 吾乃熊猫大帝, "ken" for Ken88)
  const named = (said, name) => {
    const n = String(name || '').replace(/[\s\d_\-.]+$/g, '').toLowerCase(), s = said.toLowerCase();
    if (!n) return false;
    const w = /^[\x00-\x7f]+$/.test(n) ? Math.min(3, n.length) : n.length <= 3 ? Math.min(2, n.length) : 3;
    for (let i = 0; i + w <= n.length; i++) if (s.includes(n.slice(i, i + w))) return true;
    return false;
  };
  const plainOf = s => String(s).replace(/\{[^}]*\}/g, '');
  // folded-in comments she did not name get their own turn, once, while fresh (otherwise they are the long waits).
  function requeueSkipped(e, line) {
    if (!e.also?.length) return;
    const said = plainOf(line.text || '');
    for (const a of e.also) {
      if (!a.q || a.q.skipped || named(said, a.name) || now() - a.q.at > 60e3) continue;
      queue.push({ ...a.q, skipped: true });
    }
  }

  async function loop() {
    while (running) {
      const live = onAir();
      if (!live) { showAt = null; segDone.clear(); } else if (showAt == null) showAt = now();
      if (live) noticeJoin();
      let e = next(live);
      if (!e && live && (viewers() > 0 || alone()) && now() - lastSpoke > idleMs) e = idleEvent();   // alone(): on Square she keeps going for whoever scrolls past
      if (!e) { await new Promise(r => { const timer = setTimeout(r, 2000); wake = () => { clearTimeout(timer); r(); }; }); wake = null; continue; }
      const line = await think(e);
      if (!running) break;
      if (!line) { enqueue(e); continue; }       // preempted: the bigger event goes first, this one waits its turn
      current.speaking = true;
      if (line.silent) { try { await act(line, e); } catch (err) { console.error('act failed', err); } }
      else try { await speak(line, e); } catch (err) { console.error('speak failed', err); }
      current = null;
      if (!running) break;
      requeueSkipped(e, line);
      // A silent beat does not restart the idle clock when the idol caps dead air: the next quiet beat comes right away.
      if (!line.silent) lastTalked = now();
      if (!line.silent || idol.maxQuietMs == null) lastSpoke = now();
    }
  }

  return {
    add,
    start() {
      if (!loopPromise) {
        running = true;
        // Assign the promise before starting work, so an immediate stop can wait for all cleanup.
        loopPromise = Promise.resolve().then(loop).finally(() => { running = false; current = null; wake = null; loopPromise = null; });
      }
      return loopPromise;
    },
    stop() {
      running = false;
      if (current && !current.speaking) current.abort.abort('stopped');
      wake?.();
      // Callers that need graceful shutdown can await an in-flight model/process cleanup.
      return loopPromise || Promise.resolve();
    },
    get queue() { return queue; }, get mood() { return mood; }, spend, persona, idleEvent,
  };
}

export const diaryPrompt = (idol, w, d) => `【写日记】今天（${d.date}）结束了，以${idol.name}的口吻写一篇今天的日记，150 到 250 字，像真人写的私密日记，按你的性格写。写今天直播里的人和事、你自己琢磨的事。别编价格和行情数字。
- 一些弹幕：${d.chats.slice(-8).join(' / ') || '没什么人说话'}
不用写标签，不要在末尾写字数。`;
