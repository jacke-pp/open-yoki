// The host's web room: her live picture (a Volcano RTC room, or the HLS relay as a fallback), her current line as a
// caption, one chat for web and Binance Square lines, nickname join, moves, and the about/diary column. The room
// snapshot arrives over /api/stream (feed.js). Nothing host-specific is written here: her name, picture and accounts
// all come from snapshot.idol.
import { watchRoom } from './feed.js';
import { t, lang, setLang, setVars, applyStatic } from './i18n.js';
import { createLive2DView } from './live2d.js';
import { createSimliView } from './simli.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hhmm = at => new Date(at).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
const S = 'livehost.';

let room = null, shownLine = null, sound = false, diaryDate = null;
let token = localStorage.getItem(S + 'token'), me = null;

// ---------- picture ----------
const player = new Audio();
const songPlayer = new Audio();   // a song she put on ([放歌]), quiet under her voice
const capture = new URLSearchParams(location.search);
document.body.classList.toggle('obs', capture.get('obs') === '1');
document.body.classList.toggle('landscape', capture.get('landscape') === '1');
const live2d = createLive2DView({
  container: $('live2dView'), audio: player,
  onReady: ready => {
    $('still').hidden = ready || !stillOk;
    $('placeholder').hidden = ready || stillOk;
    if (ready) $('live2dError').hidden = true;
  },
  onError: error => {
    console.warn('local avatar', error?.message || error);
    if (room?.avatar?.kind === 'live2d' && !live2d.ready) {
      $('live2dError').textContent = t('角色加载失败，暂用静态画面');
      $('live2dError').hidden = false;
    }
  },
});
let simliState = null;
function renderSimliState(state = simliState) {
  if (!state) return;
  const enabled = room?.avatar?.kind === 'simli';
  $('simliControls').hidden = !enabled;
  document.body.classList.toggle('simli-enabled', enabled);
  document.body.classList.toggle('simli-connected', enabled && state.ready);
  if (!enabled) return;
  const configured = !!room.avatar.simli?.configured;
  const seconds = Math.min(3600, Math.max(60, Number(room.avatar.simli?.maxSessionLength) || 120));
  $('simliNote').textContent = !state.local ? t('仅可在这台电脑的本地页面连接真人形象。')
    : !configured ? t('真人形象尚未配置。') : t('连接后开始计费，单次试播最多 {seconds} 秒；切换页面会断开。', { seconds });
  $('simliConnect').disabled = !state.available || state.state === 'connecting' || state.ready;
  $('simliDisconnect').disabled = state.state !== 'connecting' && !state.ready;
  const status = { idle: '未连接，显示静态画面和字幕。', connecting: '真人形象连接中…',
    connected: '真人形象已连接', expired: '试播已结束，可手动重新连接。', error: '真人形象连接失败，已断开；可手动重试。' };
  $('simliStatus').textContent = t(!room.onAir?.onAir ? '下播后已断开真人形象。' : status[state.state] || status.idle);
  $('simliStatus').title = state.error || '';
  $('still').hidden = state.ready || !stillOk;
  $('placeholder').hidden = state.ready || stillOk;
}
const simli = createSimliView({ video: $('simliVideo'), audio: $('simliAudio'), onState: state => {
  simliState = state;
  renderSimliState(state);
} });
$('simliConnect').onclick = () => { player.pause(); songPlayer.pause(); void simli.connect(); };
$('simliDisconnect').onclick = () => { void simli.disconnect(); };
let hls = null, volc = null;
const video = () => $('liveVideo');
const liveShown = () => !video().hidden || !!volc?.up || simli.ready;
// Her still picture is optional (public/art/<id>/looks/s1.jpg, added by whoever runs her); until it loads, or if it
// is missing, a neutral placeholder stands in.
let stillOk = false;
$('still').onload = () => { stillOk = true; $('placeholder').hidden = true; if (!liveShown() && !live2d.ready) $('still').hidden = false; };
$('still').onerror = () => { stillOk = false; $('still').hidden = true; $('placeholder').hidden = live2d.ready || simli.ready; };
function setView(view) {
  const img = $('still');
  if (view?.src && img.getAttribute('src') !== view.src) { stillOk = false; img.src = view.src; }
  simli.setView(view, !!room?.onAir?.onAir);
  renderSimliState();
  if (view?.kind === 'simli') {
    stopVolc(); stopLive(); live2d.setView(null);
    $('rtc').hidden = true; $('live2dError').hidden = true; $('live2dCredit').hidden = true;
    player.pause(); songPlayer.pause();
    img.hidden = simli.ready || !stillOk;
    $('placeholder').hidden = simli.ready || stillOk;
    return;
  }
  if (view?.kind === 'live2d') {
    stopVolc(); stopLive(); $('rtc').hidden = true;
    $('live2dCredit').textContent = view.live2d?.credit || '';
    $('live2dCredit').hidden = !view.live2d?.credit;
    img.hidden = live2d.ready || !stillOk;
    $('placeholder').hidden = live2d.ready || stillOk;
    live2d.setView(view);
    if (sound) live2d.resumeAudio().catch(error => console.warn('avatar audio', error?.message || error));
    return;
  }
  live2d.setView(null); $('live2dError').hidden = true; $('live2dCredit').hidden = true;
  if (view?.kind === 'volc') { stopLive(); playVolc(view); img.hidden = !!volc?.up; $('rtc').hidden = !!volc?.up; return; }
  stopVolc();
  if (view?.kind === 'hls') { playLive(view.src); img.hidden = true; $('rtc').hidden = true; return; }
  stopLive();
  img.hidden = !stillOk;
  $('rtc').hidden = view?.kind !== 'rtc';
}
function playLive(src) {
  const v = video();
  if (v.dataset.src === src) return;
  v.dataset.src = src; v.hidden = false; v.muted = !sound;
  if (window.Hls?.isSupported()) {
    hls = new Hls({ liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 6, maxLiveSyncPlaybackRate: 1.1 });
    hls.loadSource(src); hls.attachMedia(v);
    hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) { stopLive(); setTimeout(() => room && setView(room.avatar), 3000); } });
  } else v.src = src;
  v.play().catch(() => {});
}
function stopLive() {
  const v = video();
  if (v.hidden) return;
  hls?.destroy(); hls = null;
  v.removeAttribute('src'); v.load(); v.hidden = true; delete v.dataset.src;
}
const loadScript = src => new Promise((ok, bad) => {
  if (document.querySelector(`script[src="${src}"]`)) return window.VERTC ? ok() : setTimeout(() => loadScript(src).then(ok, bad), 300);
  const el = document.createElement('script'); el.src = src; el.onload = ok; el.onerror = bad; document.head.append(el);
});
async function playVolc(view) {
  const key = view.room_id + '/' + view.publisher;
  if (volc?.key === key) return;
  stopVolc();
  const mine = volc = { key, pub: view.publisher, up: false };
  try {
    await loadScript('/vendor/volc-rtc.min.js');
    const r = await fetch('/api/rtc-ticket', { cache: 'no-store' });
    if (!r.ok) throw new Error('ticket ' + r.status);
    const tk = await r.json();
    if (volc !== mine) return;
    const V = window.VERTC.default || window.VERTC;
    const engine = mine.engine = V.createEngine(tk.app_id);
    engine.on(V.events.onUserPublishStream, ({ userId }) => {
      if (volc !== mine || userId !== mine.pub || mine.up) return;
      mine.up = true;
      $('volcView').hidden = false;
      engine.setRemoteVideoPlayer(0, { userId, renderDom: $('volcView'), renderMode: 0 });
      $('still').hidden = true; $('rtc').hidden = true;
      if (sound) volcAudio(true);
    });
    engine.on(V.events.onUserUnpublishStream, ({ userId }) => {
      if (volc !== mine || userId !== mine.pub) return;
      mine.up = false; $('volcView').hidden = true; $('still').hidden = !stillOk;
    });
    await engine.setUserVisibility(false);
    await engine.joinRoom(tk.token, tk.room_id, { userId: tk.user_id }, { isAutoPublish: false, isAutoSubscribeAudio: false, isAutoSubscribeVideo: true });
  } catch (err) {
    console.warn('live picture', err?.message || err);
    if (volc === mine) { stopVolc(); setTimeout(() => room && setView(room.avatar), 5000); }
  }
}
function volcAudio(on) {
  const mine = volc;
  if (!mine?.engine || !mine.up) return;
  for (const el of document.querySelectorAll('audio')) el.muted = !on;
  if (on) mine.engine.subscribeStream(mine.pub, 1).then(() => { for (const el of document.querySelectorAll('audio')) el.muted = !sound; return mine.engine.play?.(mine.pub, 1); }).catch(() => {});
  else mine.engine.unsubscribeStream(mine.pub, 1).catch(() => {});
}
function stopVolc() {
  const mine = volc;
  if (!mine) return;
  volc = null;
  $('volcView').hidden = true; $('volcView').replaceChildren();
  if (mine.engine) mine.engine.leaveRoom().catch(() => {}).finally(() => { try { (window.VERTC.default || window.VERTC).destroyEngine(mine.engine); } catch {} });
}
// HLS runs a few seconds behind the server; the caption waits the same so it stays with her mouth.
const liveLag = () => {
  if (!liveShown()) return 0;
  if (simli.ready) return 0;
  if (volc?.up) return 300;
  const l = hls ? hls.latency : 0;
  return Math.min(15000, Math.max(0, (Number.isFinite(l) && l > 0 ? l : 4) * 1000));
};

// ---------- caption ----------
let typing = null;
function showLine(line, snapTime) {
  if (!line || shownLine === line.id) return;
  const first = shownLine === null;
  shownLine = line.id;
  const fresh = !first || (snapTime || Date.now()) - line.at < 2500;
  const lag = fresh ? liveLag() : 0;
  if (lag) setTimeout(() => shownLine === line.id && paintLine(line, fresh), lag); else paintLine(line, fresh);
}
function paintLine(line, fresh) {
  const el = $('line'), text = line.text || '';
  clearInterval(typing);
  const asked = line.replyTo && room?.chat?.find(c => c.id === line.replyTo);
  const seen = line.seen;
  $('replyTo').innerHTML = asked ? t('回复 <b>{who}</b>：{text}', { who: esc(asked.who), text: esc(asked.request ? t('点了「{a}」', { a: t(asked.request) }) : asked.text) })
    : seen ? t(seen.who ? '刷到{src} <b>{who}</b>：{text}' : '刷到{src}：{text}', { src: t(seen.src), who: esc(seen.who), text: esc(seen.text) }) : '';
  simli.perform(line, fresh);
  if (!fresh) { el.textContent = text; return; }
  live2d.perform(line);
  if (line.action) showMove(line.action);
  const total = line.durationMs || Math.max(2000, text.length * 120);
  const step = Math.min(70, Math.max(25, total * 0.8 / Math.max(1, text.length)));
  let i = 0;
  el.textContent = '';
  typing = setInterval(() => { el.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(typing); }, step);
  if (sound && line.audio && !liveShown() && room?.avatar?.kind !== 'simli') { player.src = line.audio; player.play().catch(() => {}); }
  if (line.bgm?.url && room?.avatar?.kind !== 'simli') {
    if (!line.action) showMove('♪ ' + line.bgm.title);
    if (sound) { songPlayer.src = line.bgm.url; songPlayer.volume = 0.32; songPlayer.play().catch(() => {}); }
  }
}
function showMove(name) {
  const tag = $('moveTag');
  tag.textContent = t(name); tag.hidden = false;
  tag.classList.remove('pop'); void tag.offsetWidth; tag.classList.add('pop');
  clearTimeout(showMove.t); showMove.t = setTimeout(() => { tag.hidden = true; }, 2600);
}

// ---------- room ----------
const ROUTE_NAMES = { model: '大脑', voice: '配音', avatar: '画面', chat: '公屏' };
const ROUTE_STATE = { ok: '正常', down: '出错', off: '关闭' };
// Her accounts: the config may give a full link or just a handle.
const squareUrl = sq => !sq ? '' : typeof sq === 'string' ? (/^https:\/\//.test(sq) ? sq : '') : sq.url || (sq.handle ? `https://www.binance.com/square/profile/${encodeURIComponent(sq.handle)}` : '');
const xUrl = x => { const h = String((typeof x === 'object' ? x?.handle : x) || '').replace(/^@/, ''); return /^\w{1,15}$/.test(h) ? `https://x.com/${h}` : ''; };
const tgUrl = tg => { const u = typeof tg === 'string' ? tg : tg?.link || ''; return /^https:\/\/t\.me\//.test(u) ? u : ''; };
let shownName = null;
function renderWho(idol) {
  const name = idol.name || idol.nameEn || '';
  const shown = lang === 'en' ? idol.nameEn || name : name;
  if (shown === shownName) return;
  shownName = shown;
  setVars({ name: shown });
  applyStatic();
  $('name').textContent = shown;
  $('badge').textContent = [...shown][0] || '';
  $('still').alt = shown;
}
function render(snap, prev) {
  renderWho(snap.idol || {});
  $('viewers').textContent = snap.viewers;
  $('regulars').textContent = snap.memo?.regulars ?? 0;
  const w = snap.schedule?.[0];
  if (w) $('showTime').textContent = t('每晚 {from}–{to}', { from: localClock(w.from, snap.tz), to: localClock(w.to, snap.tz) });
  const sq = squareUrl(snap.idol.square), xu = xUrl(snap.idol.x), tu = tgUrl(snap.idol.tg);
  $('squareBtn').hidden = !sq; $('squareSoon').hidden = !!sq;
  if (sq) $('squareBtn').href = sq;
  $('xLink').hidden = !xu; if (xu) $('xLink').href = xu;
  $('tgLink').hidden = !tu; if (tu) $('tgLink').href = tu;
  $('links').hidden = !xu && !tu;
  $('offNote').textContent = w ? t('每晚 {from}–{to}（你的当地时间），币安广场和这里同时开。', { from: localClock(w.from, snap.tz), to: localClock(w.to, snap.tz) }) : '';
  setView(snap.avatar);
  renderBoard(snap);
  renderAir(snap);
  showLine(snap.line, snap.time);
  if (!prev || prev.chat !== snap.chat) renderChat(snap.chat);
  if (!prev || String(prev.diaryDates) !== String(snap.diaryDates)) renderDiaryDates(snap.diaryDates);
  const moves = Object.keys(snap.idol.actions || {});
  const html = moves.map(k => `<button type="button" data-a="${esc(k)}">${esc(t(k))}</button>`).join('');
  if ($('moves').innerHTML !== html) $('moves').innerHTML = html;
  $('routes').innerHTML = Object.entries(snap.routes || {}).filter(([k]) => ROUTE_NAMES[k]).map(([k, v]) => `<span class="route ${v}" title="${esc(snap.why?.[k] || '')}">${t(ROUTE_NAMES[k])} ${t(ROUTE_STATE[v] || v)}</span>`).join('');
}
// The Binance board she reads from, and her market notebook: tonight's guess, the last answer, the record. No money
// is involved; the guess is checked against the price a day later.
const money = n => n >= 1000 ? Math.round(n).toLocaleString('en-US') : n >= 1 ? String(+n.toFixed(2)) : String(+n.toPrecision(3));
const chg = n => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
function renderBoard(snap) {
  const b = snap.market;
  $('board').hidden = !b && !snap.calls?.list?.length;
  $('ticks').innerHTML = (b?.majors || []).map(c => `<li><b>${esc(c.coin)}</b><span>${money(c.price)}</span><i class="${c.chg > 0 ? 'up' : c.chg < 0 ? 'down' : ''}">${chg(c.chg)}</i></li>`).join('');
  $('coinCount').textContent = b?.count?.all ? t('她能查到币安上 {n} 个币：现货、合约和 Alpha。', { n: b.count.all.toLocaleString('en-US') }) : '';
  const list = snap.calls?.list || [], open = list.find(c => c.right === null), last = list.find(c => c.right !== null), s = snap.calls?.score;
  const bits = [];
  if (open) bits.push(t('今晚她猜 <b>{coin}</b> 明天这时候{dir}，当时 {price}。', { coin: esc(open.coin), dir: t(open.dir === 'up' ? '更高' : '更低'), price: money(open.price) }));
  if (last) bits.push(t('上一次猜 {coin}：{from} 到 {to}，她{verdict}。', { coin: esc(last.coin), from: money(last.price), to: last.end ? money(last.end) : '?', verdict: t(last.right ? '说对了' : '说错了') }));
  if (s?.total) bits.push(t('看盘记录 {right}/{total}', { right: s.right, total: s.total }));
  $('calls').innerHTML = bits.length ? bits.join(' ') : t('每晚开播她会猜一次行情，第二天自动对答案。不是投资建议。');
}
// "20:00" in her time zone, shown in the visitor's own clock.
function localClock(hm, tz = 8) {
  const [h, m] = hm.split(':').map(Number), d = new Date();
  return hhmm(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h - tz, m));
}
function renderAir(snap) {
  const on = !!snap.onAir?.onAir;
  document.body.classList.toggle('on', on);
  $('airText').dataset.i18n = on ? '直播中' : '现在没在播';
  $('airText').textContent = t($('airText').dataset.i18n);
  $('offair').hidden = on;
  const held = snap.onAir?.forced === 'off';
  $('nextWrap').hidden = held || !snap.onAir?.nextAt;
  $('nextShow').textContent = snap.onAir?.nextAt ? hhmm(snap.onAir.nextAt) : '—';
  tick();
}
function tick() {
  const at = room?.onAir?.nextAt;
  if (!at || room?.onAir?.onAir || room?.onAir?.forced === 'off') { $('countdown').textContent = ''; return; }
  const s = Math.max(0, Math.floor((at - Date.now()) / 1000));
  $('countdown').textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
setInterval(tick, 1000);

function renderChat(list) {
  const items = [...list].reverse();   // oldest at the top, newest by the input
  $('chat').innerHTML = items.length ? items.map(c => `<li class="${c.replied ? 'replied' : ''}${c.request ? ' req' : ''}"><span class="src src-${esc(c.from || 'web')}">${c.from === 'x' ? 'X' : t(c.from === 'square' ? '广场' : '网页')}</span><b>${esc(c.who)}</b><span class="txt">${esc(c.request ? t('点了「{a}」', { a: t(c.request) }) : c.text)}</span>${c.replied ? `<em>${t('她回了')}</em>` : ''}</li>`).join('')
    : `<li class="empty">${t('还没人说话，第一句留给你。')}</li>`;
  $('chat').scrollTop = $('chat').scrollHeight;
}
function renderDiaryDates(dates) {
  $('diaryDates').innerHTML = dates.slice(0, 7).map(d => `<button type="button" data-date="${d}" class="${d === diaryDate ? 'on' : ''}">${t('{m}月{d}日', { m: Number(d.slice(5, 7)), d: Number(d.slice(8, 10)) })}</button>`).join('');
  if (!diaryDate && dates.length) openDiary(dates[0]);
}
async function openDiary(date) {
  diaryDate = date;
  for (const b of $('diaryDates').children) b.classList.toggle('on', b.dataset.date === date);
  const d = await fetch(`/api/diary?date=${date}`).then(r => r.json()).catch(() => null);
  if (d) $('diary').innerHTML = d.text.split(/\n+/).map(p => `<p>${esc(p)}</p>`).join('');
}
$('diaryDates').onclick = e => { const b = e.target.closest('button[data-date]'); if (b) openDiary(b.dataset.date); };

watchRoom({
  onRoom: snap => { const prev = room; room = snap; render(snap, prev); },
  onOffline: off => { document.body.classList.toggle('offline', off); if (off) $('airText').textContent = t('连接断了，正在重连'); },
});

// ---------- joining and talking ----------
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
  .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ? t(j.error) : t('出错了（{status}）', { status: r.status })); return j; });
const hint = (text, bad) => { $('hint').textContent = text; $('hint').classList.toggle('bad', !!bad); };

async function refreshMe() {
  me = null;
  if (token) {
    const r = await fetch(`/api/me?token=${token}`).catch(() => null);
    if (r?.ok) me = await r.json(); else { token = null; localStorage.removeItem(S + 'token'); }
  }
  $('joinForm').hidden = !!me; $('sayForm').hidden = !me;
  if (me) { $('meName').textContent = me.who; hint(t('你是 {name}。说话进弹幕，她挑着回。', { name: me.who })); }
}
$('joinForm').onsubmit = async e => {
  e.preventDefault();
  const name = $('nickInput').value.trim();
  if (!name) { hint(t('先起个昵称'), true); $('nickInput').focus(); return; }
  try { const r = await post('/api/guest', { name }); token = r.token; localStorage.setItem(S + 'token', token); await refreshMe(); $('sayInput').focus(); }
  catch (err) { hint(err.message, true); }
};
$('logoutBtn').onclick = () => { localStorage.removeItem(S + 'token'); token = null; refreshMe().then(() => $('nickInput').focus()); };
$('sayForm').onsubmit = async e => {
  e.preventDefault();
  const text = $('sayInput').value.trim();
  if (!text) return;
  try { await post('/api/chat', { token, text }); $('sayInput').value = ''; hint(t('发出去了，她看到了。')); }
  catch (err) { hint(err.message, true); }
};
$('moves').onclick = async e => {
  const b = e.target.closest('button[data-a]');
  if (!b || b.disabled) return;
  b.disabled = true;
  try { await post('/api/request', { token, action: b.dataset.a }); hint(t('收到，她做完手上这句就来。')); }
  catch (err) { hint(err.message, true); }
  finally { b.disabled = false; }
};
// The first-screen button: straight to the nickname box (or the chat box once joined).
$('goBtn').onclick = () => {
  const target = me ? $('sayInput') : $('nickInput');
  target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  target.focus({ preventScroll: true });
};

function setSound(on) {
  sound = on;
  simli.setSound(on);
  if (on && simli.ready) $('simliAudio').play().catch(() => {});
  if (on && room?.avatar?.kind === 'live2d') live2d.resumeAudio().catch(error => console.warn('avatar audio', error?.message || error));
  if (!on) songPlayer.pause();
  $('soundBtn').dataset.i18n = on ? '关声音' : '开声音';
  $('soundBtn').textContent = t($('soundBtn').dataset.i18n);
  $('soundBtn').setAttribute('aria-pressed', String(on));
  if (room?.avatar?.kind === 'simli') { player.pause(); return; }
  if (volc?.up) return volcAudio(on);
  if (liveShown()) { video().muted = !on; if (on) video().play().catch(() => {}); return; }
  if (!on) player.pause();
}
$('soundBtn').onclick = () => setSound(!sound);

function showLang() { $('langBtn').textContent = lang === 'en' ? '中' : 'EN'; }
$('langBtn').onclick = () => {
  setLang(lang === 'en' ? 'zh' : 'en');
  showLang();
  shownName = null;
  if (room) render(room, null);
  refreshMe();
};
applyStatic();
showLang();
refreshMe();
window.addEventListener('pagehide', event => { if (!event.persisted) { live2d.destroy(); void simli.destroy(); } player.pause(); songPlayer.pause(); });
