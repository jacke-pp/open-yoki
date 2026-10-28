// The live host's server: one Node process serves the web room (snapshot + live stream), the public chat, the Binance
// Square feed and the host herself (mouth, voice, avatar, heart). Which host is `IDOL=<folder>` under idols/
// (default example). Each route (model, voice, avatar, chat) keeps its own status and fails on its own: a dead voice
// key never stops the chat, a dead model never stops the picture.
//   AVATAR=mock|vidu|live2d|simli  cloud video, a local Live2D model, or a still picture
//   ON_AIR=on|off     override the host's schedule (on for local testing)
//   MODE=show|test    show (default) runs the real schedule; test forces her on air and opens /api/test/* controls
// Every key comes from the environment (see .env.example); nothing is read from key files here.
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createWorld, MOODS, whoOf } from './world.mjs';
import { createBrain, diaryPrompt, fitLength, takeInner } from './brain.mjs';
import { createAvatar } from './avatar.mjs';
import { createReplyProvider } from './model-provider.mjs';
import { createSimliService, isLocalSimliRequest, SimliError } from './simli.mjs';
import { createFiller } from './filler.mjs';
import { createHeart, claudeRunner, fallbackRunner } from './heart.mjs';
import { dsRunner } from './heartds.mjs';
import { createOutbox } from './outbox.mjs';
import { createTg, tgApi } from './tg.mjs';
import { createXReply } from './xreply.mjs';
import { createXClient } from './xapi.mjs';
import { createWeb } from './web.mjs';
import { createCoinank } from './coinank.mjs';
import { createFamilyChat, membersOf, dsChat, FAMILY_MODEL, FAMILY_BACKUP } from './family.mjs';
import { createTown, townAllowed } from './town.mjs';
import { createRelay } from './relay.mjs';
import { createVolcRoom } from './rtc.mjs';
import { createSchedule, clockIn, showCue } from './schedule.mjs';
import { falVoice, doubaoVoice, plainText, saidPart, VOICE, doubaoResource } from './voice.mjs';
import { createAuth, AuthError, isGuest } from './auth.mjs';
import { liveRoom, watchGate } from './live.mjs';
import { createMemory } from './memory.mjs';
import { createMarket, price as fmtPrice, pct as fmtPct, ALIASES } from './market.mjs';
import { createSquare, cleanComments, createSquareRoom, watching, coinView } from './square.mjs';
import { createSongs } from './songs.mjs';
import { createMemes } from './memes.mjs';
import { createNews, createSquareFeed } from './news.mjs';
import { createXLearn } from './xlearn.mjs';
import { createPushTalk } from './pushes.mjs';
import { createToday } from './today.mjs';
import { createBigMoves } from './bigmoves.mjs';
import { createRadio, radioSpeed } from './radio.mjs';
import undici from 'undici';

// Keep connections to Doubao (and Vidu) open between lines: fetch's own default drops an idle connection after 4 s and
// the next line pays a fresh TLS handshake, roughly doubling the time to her first sound from a far region. Doubao
// keeps an idle connection at least 60 s; voice.warm() tops it up while on air. NODE_USE_ENV_PROXY=1 keeps a local proxy.
const keepAlive = { keepAliveTimeout: 120e3, keepAliveMaxTimeout: 600e3 };
const viaProxy = process.env.NODE_USE_ENV_PROXY === '1' && (process.env.HTTPS_PROXY || process.env.https_proxy);
undici.setGlobalDispatcher(viaProxy ? new undici.EnvHttpProxyAgent(keepAlive) : new undici.Agent(keepAlive));
// undici 7 can trip its own assert when a server closes a kept-alive socket mid-response (assert(!this.paused) in
// client-h1). Only that connection is lost and the next fetch opens a new one, so it is logged instead of taking the
// show down; anything else still ends the process for systemd to restart.
process.on('uncaughtException', (e) => {
  if (e?.code === 'ERR_ASSERTION' && /undici[\\/]lib[\\/]dispatcher/.test(e.stack || '')) { console.warn('undici socket assert, connection dropped: ' + String(e.message).slice(0, 80)); return; }
  console.error(e); process.exit(1);
});

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// constant-time check of a shared key sent in a header
const keyOk = (got, want) => { const k = String(got || ''); return !!want && k.length === want.length && timingSafeEqual(Buffer.from(k), Buffer.from(want)); };

// What she is looking at while she talks about it, shown above her line like a streamer sharing her screen.
function seenOf(e) {
  if (e.kind === 'post') return { src: '广场', who: e.item.who, text: e.item.text.slice(0, 60) };
  if (e.kind === 'learned') return { src: '推特', who: e.item.who ? '@' + e.item.who : '', text: e.item.what };
  if (e.kind === 'news') return { src: '快讯', who: '', text: e.item.title };
  if (e.kind === 'today') return { src: e.item.from || '热搜', who: '', text: e.item.what };
  if (e.kind === 'push') return { src: '币安在推', who: '', text: `${e.item.name}：${e.item.what}`.slice(0, 60) };
  return null;
}

// A new heart home starts as a copy of heart-template/ (the blank persona pages), with {name} and {tzName} filled in.
// Nothing is copied over a home that already has 我是谁.md, and no file that exists is ever overwritten.
export function seedHeartHome(home, template, vars = {}) {
  if (!home || !template || !fs.existsSync(template)) return false;
  if (fs.existsSync(path.join(home, '我是谁.md'))) return false;
  const fill = s => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name), b = path.join(to, e.name);
      if (e.isDirectory()) copy(a, b);
      else if (e.name !== '.gitkeep' && !fs.existsSync(b)) fs.writeFileSync(b, e.name.endsWith('.md') ? fill(fs.readFileSync(a, 'utf8')) : fs.readFileSync(a));
    }
  };
  copy(template, home);
  return true;
}

// Who she is to the shared modules (family, radio, town): name, show time and where people find her.
export function hostOf(idol) {
  return { name: idol.name, show: idol.show || '', square: idol.square || null, x: idol.x || '', site: idol.site || '', tg: idol.tg || null };
}

export async function start(env = process.env) {
  const idol = (await import(`../idols/${env.IDOL || 'example'}/config.mjs`)).default;
  const STAGES = idol.stages;
  const mode = env.MODE || 'show';
  if (!['show', 'test'].includes(mode)) throw new Error('MODE must be show or test');
  const tz = idol.tz ?? 8;
  const host = hostOf(idol);
  const dataDir = env.DATA_DIR || path.join(ROOT, 'data', mode);
  // Show journal: every line she says, every comment, walk-in and thank-you, to the millisecond, one file a day in
  // <data>/show/. The clip tools cut the replay with it. Never read back by the server except after a restart mid-show.
  const showDir = path.join(dataDir, 'show');
  const showLog = o => { try { fs.mkdirSync(showDir, { recursive: true }); fs.appendFileSync(path.join(showDir, new Date().toISOString().slice(0, 10) + '.jsonl'), JSON.stringify({ at: Date.now(), ...o }) + '\n'); } catch {} };
  const world = createWorld({ idol, file: path.join(dataDir, 'world.json') });
  const routes = { model: { on: false }, voice: { on: false }, avatar: { on: true }, chat: { on: true } };
  // Her long-term memory (memory.mjs): regulars, last night, her own calls. Saved with the room.
  const memory = createMemory({ file: path.join(dataDir, 'memory.json'), tz });
  const memes = createMemes({ dir: dataDir });
  const status = (r, ok, err) => { routes[r] = { ...routes[r], ok, at: Date.now(), err: ok ? undefined : err }; };

  const reply = createReplyProvider({ env, idol });
  const falKey = env.FAL_KEY || null;
  routes.model.on = reply.enabled;
  // Voice: her Doubao voice when its key and voice id are there, else fal MiniMax as the fallback.
  const volcKey = env.VOLC_API_KEY || null;
  const dv = idol.avatar.doubao ? { ...idol.avatar.doubao, voiceId: env.DOUBAO_VOICE_ID || idol.avatar.doubao.voiceId } : null;
  const useDoubao = !!(volcKey && dv?.voiceId && env.VOICE_PROVIDER !== 'fal');
  routes.voice.on = (useDoubao || !!falKey) && env.VOICE_OFF !== '1';
  const voiceDir = path.join(dataDir, 'audio'), dailyChars = Number(env.TTS_DAILY_CHARS || 60000);
  const stageVoice = !routes.voice.on ? null
    : useDoubao ? doubaoVoice({ key: volcKey, dir: voiceDir, dailyChars, voiceId: dv.voiceId, context: dv.context, speed: dv.speed || 0, tones: dv.tones || {}, status })
    : falVoice({ key: falKey, dir: voiceDir, dailyChars, voiceId: idol.fallbackVoice.voiceId, speed: idol.fallbackVoice.speed, status });
  const voice = stageVoice;
  // With a DeepSeek key the mouth talks to DeepSeek directly (thinking off, MOUTH_DS model) and reads a page of facts
  // (brain.mjs factFor, idol.mouth.direct); OpenRouter's main model backs it up. MOUTH_DIRECT=0 uses OpenRouter only.
  const mouthDirect = reply.direct;
  const ask = reply.ask;

  let live = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // Watching: our own Volcano RTC room, one ticket per visitor, near real time. WATCH=relay falls back to the server
  // relay (one managed ticket re-streamed as HLS, a few seconds behind).
  const rtcApp = env.VOLC_RTC_APP_ID, rtcKey = env.VOLC_RTC_APP_KEY;
  const room = env.AVATAR === 'vidu' && env.WATCH !== 'relay' && rtcApp && rtcKey ? createVolcRoom({ appId: rtcApp, appKey: rtcKey, roomId: env.RTC_ROOM || `lh-${String(idol.short || idol.id).toLowerCase()}-${mode}` }) : null;
  let heardAt = Date.now();              // last time anyone in the room said something; a long quiet lets her drift off
  const avatar = createAvatar({ idol, kind: env.AVATAR || 'mock', voice, status, env, room, lookDir: path.join(ROOT, 'public', 'art', idol.id, 'looks'), quiet: () => Date.now() - heardAt });
  const simli = avatar.kind === 'simli' ? createSimliService({ env }) : null;
  // Binance Square feed (square.mjs): on once <data>/square.json holds Square's RTMP address and key.
  const chrome = env.SQUARE_CHROME || env.CHROMIUM_PATH || (fs.existsSync('/opt/google/chrome/chrome') ? '/opt/google/chrome/chrome' : undefined);
  // Square's own count of her room and who walks in (POST /api/square/room).
  const squareRoom = createSquareRoom();
  // whole songs under her voice on the evening show too, the same list as the radio's
  const showSongs = env.SHOW_SONGS === '0' ? null : createSongs({ dir: env.RADIO_SONG_DIR || path.join(dataDir, 'songs'), log: m => console.log(m) });
  const songNote = a => a?.id ? `（点歌：《${a.title}》已经给他放上了）` : a?.miss ? `（点歌：歌单里没有《${a.miss}》）` : '';
  const playNextSong = () => { const s = showSongs?.next(); if (s) square?.song(s); };
  const still = path.join(ROOT, 'public', 'art', idol.id, 'looks', 's1.jpg');
  const square = room ? createSquare({ file: path.join(dataDir, 'square.json'), bgmDir: path.join(dataDir, 'bgm'), songDir: showSongs ? (env.RADIO_SONG_DIR || path.join(dataDir, 'songs')) : '', onSongEnded: id => { if (showSongs?.current?.id === id) playNextSong(); }, room, still, clips: Object.keys(idol.bigMoves?.clips || {}).filter(k => fs.existsSync(path.join(ROOT, 'relay', 'clips', k + '.mp4'))), status, chromiumPath: chrome, tap: env.SQUARE_TAP || '',
    page: { name: idol.name, tagline: idol.tagline || '', tz, tzLabel: idol.tzName || '' } }) : null;
  // Between shows: a voice-only radio live on Square with her voice answering chat, no Vidu (radio.mjs).
  // Her radio voice is the same Doubao voice a notch slower; the evening show keeps its own speed.
  const radioVoice = stageVoice && useDoubao ? doubaoVoice({ key: volcKey, dir: voiceDir, dailyChars, voiceId: dv.voiceId, context: dv.context, speed: radioSpeed(dv), status }) : voice;
  const radio = square ? createRadio({ file: path.join(dataDir, 'square.json'), stateFile: path.join(dataDir, 'radio.json'), factsFile: path.join(dataDir, 'facts.json'), ask, voice: radioVoice, audioDir: voiceDir, still, chromiumPath: chrome, status, dailyChars: Number(env.RADIO_DAILY_CHARS || 40000), songDir: env.RADIO_SONG_DIR || path.join(dataDir, 'songs'),
    host: { name: idol.name, showAt: idol.liveAt || '', ...(idol.radio || {}), title: env.RADIO_TITLE || idol.radio?.title || '' }, tz }) : null;
  avatar.setStage(world.w.stage);
  if (room) routes.rtc = { on: true };
  const bigMoves = square && idol.bigMoves ? createBigMoves(idol.bigMoves) : null;
  // Without our own RTC room, Vidu's picture reaches visitors through the relay (the server watches with the one ticket).
  const relay = avatar.kind === 'vidu' && !room && env.RELAY !== 'off' ? createRelay({ dir: path.join(dataDir, 'hls'), status, chromiumPath: env.CHROMIUM_PATH }) : null;
  if (relay) routes.relay = { on: true };
  // Her heart (heart.mjs): only where its home (HEART_HOME) and a key are set up; without it she runs on the mouth alone.
  // A test stream (HEART_SCRATCH=1, set along with ON_AIR for short self-tests) runs her heart on a fresh copy of her
  // home and posts nothing, so made-up test viewers never get into her real diary, people or posts.
  const heartHome0 = env.HEART_HOME, heartState0 = env.HEART_STATE || (heartHome0 && path.join(heartHome0, '../.state'));
  if (heartHome0 && seedHeartHome(heartHome0, env.HEART_TEMPLATE || path.join(ROOT, '..', 'heart-template'), { name: idol.name, tzName: idol.tzName || '当地时间' })) console.log('heart: new home from heart-template');
  const scratch = !!heartHome0 && env.HEART_SCRATCH === '1';
  const heartHome = scratch ? heartHome0 + '-test' : heartHome0, heartState = scratch ? heartState0 + '-test' : heartState0;
  if (scratch) {
    for (const d of [heartHome, heartState]) fs.rmSync(d, { recursive: true, force: true });
    fs.cpSync(heartHome0, heartHome, { recursive: true }); fs.mkdirSync(heartState, { recursive: true });
    console.log('heart: scratch copy for a test');
  }
  const heartKey = env.HEART_KEY || null;   // Anthropic key (or a compatible relay's key with HEART_BASE_URL)
  const dsDirect = !!env.HEART_KEY_DS && env.HEART_DS_DIRECT !== '0';   // her home's CLAUDE.md goes in the prompt then
  // Off air her heart can go online: web search and pages, X, Douyin's hot list, within a daily budget. On air she is
  // busy with the room, and a slow page would stall the show, so the tools are hidden then.
  const web = env.HEART_HOME && env.HEART_WEB !== '0' ? createWeb({ stateDir: heartState, env,
    perDayUsd: Number(env.HEART_WEB_USD || 20), tz, log: m => console.log(m) }) : null;
  const webTools = web ? { get tools() { return showOpen ? [] : web.tools; }, run: (n, a) => web.run(n, a) } : null;
  // CoinAnk (optional key): how the futures crowd stands, read-only notes in her home for the room's questions.
  const coinank = env.COINANK_API_KEY && env.HEART_HOME ? createCoinank({ key: env.COINANK_API_KEY, dir: path.join(heartHome, '交易资料'), tz, log: m => console.log(m) }) : null;
  if (coinank) { const pull = () => coinank.refresh().catch(err => console.log('coinank:', err.message)); setTimeout(pull, 15e3).unref?.(); setInterval(pull, 5 * 60e3).unref?.(); }

  // Which models her heart thinks with. DeepSeek first when HEART_KEY_DS is set (Flash on air for quick beats, the
  // larger model off air for the diary and the operators' group), Claude behind it; Claude alone otherwise.
  function heartRun() {
    const model = env.HEART_MODEL || 'claude-sonnet-5-5', configDir = path.join(heartState, 'cfg');
    const claude = [];
    // an Anthropic-compatible relay first when its key is set (HEART_KEY_RELAY + HEART_RELAY_URL); a bad key hangs in
    // the CLI's retries, hence the short timeout
    if (env.HEART_KEY_RELAY && env.HEART_RELAY_URL) claude.push(['relay', claudeRunner({ key: env.HEART_KEY_RELAY, keyVar: 'ANTHROPIC_AUTH_TOKEN', baseUrl: env.HEART_RELAY_URL, model, configDir, timeoutMs: 45e3 }), 'claude']);
    if (heartKey) claude.push(['claude', claudeRunner({ key: heartKey, model, configDir, ...(env.HEART_BASE_URL ? { baseUrl: env.HEART_BASE_URL, keyVar: 'ANTHROPIC_AUTH_TOKEN' } : {}) }), 'claude']);
    if (!env.HEART_KEY_DS) return claude.length > 1 ? fallbackRunner(claude, m => console.log(m)) : claude[0][1];
    // Straight to DeepSeek's own API by default (heartds.mjs): through the Claude Code CLI she sounded like a coding
    // assistant. HEART_DS_DIRECT=0 goes back to the CLI on DeepSeek's Anthropic endpoint.
    const ds = (m, timeoutMs) => dsDirect ? dsRunner({ extra: webTools, key: env.HEART_KEY_DS, model: m, sessionDir: path.join(heartState, 'ds-sessions'), timeoutMs }) : claudeRunner({ key: env.HEART_KEY_DS, keyVar: 'ANTHROPIC_AUTH_TOKEN', baseUrl: env.HEART_DS_URL || 'https://api.deepseek.com/anthropic', model: m, configDir, timeoutMs });
    const live = ['ds-flash', ds(env.HEART_DS_LIVE || 'deepseek-flash', 150e3), 'deepseek'], day = ['ds-pro', ds(env.HEART_DS_DAY || 'deepseek-v4-pro', 300e3), 'deepseek'];
    return fallbackRunner(() => [showOpen ? live : day, ...claude], m => console.log(m));
  }
  const heart = env.HEART_HOME && (heartKey || env.HEART_KEY_DS) ? createHeart({ home: heartHome, stateDir: heartState,
    run: heartRun(), withHouse: dsDirect, name: idol.name, tzName: idol.tzName,
    tz, awake: idol.heartAwake, onAir: () => showOpen, daytime: () => herDay(), showAt: env.HEART_SHOW_AT || idol.liveAt || null, log: m => console.log(m) }) : null;
  if (heart) { setInterval(() => heart.tick(), 5000).unref(); console.log('heart: on'); }
  // X, the official API with her own account's keys (xapi.mjs). Without X_* keys nothing goes to X.
  const xClient = heart && !scratch ? createXClient({ env, stateFile: path.join(heartState, 'xapi.json'), log: m => console.log(m) }) : null;
  // Her own posts (outbox.mjs): what she writes in 想发的动态/ goes to Square (the ops poster takes it) and to X.
  const outbox = heart && !scratch ? createOutbox({ home: heartHome, stateDir: heartState, tz, x: xClient?.configured.user ? xClient : null, feed: l => heart.feed(l), log: m => console.log(m) }) : null;
  if (outbox) setInterval(() => { try { outbox.scan(); } catch (err) { console.log('outbox:', err.message); } }, 60e3).unref();
  // Her Telegram groups (tg.mjs): TG_DIR/bot.json holds the bot token, the fan group's id, the bot's own id and the
  // operators' group ({ family: { chatId, members: { <user id>: '名字（介绍）' } } }). Keep it owner-only (600).
  let tgConf = null;
  try { if (env.TG_DIR) tgConf = JSON.parse(fs.readFileSync(path.join(env.TG_DIR, 'bot.json'), 'utf8')); } catch (err) { console.log('tg: no config', err.message); }
  // The operators' group talks straight to DeepSeek when HEART_KEY_DS is set; her heart hears each exchange. Without
  // the key, or if DeepSeek fails, the group's lines go to the heart instead.
  const tgSend = tgConf?.token ? tgApi(tgConf.token) : null;
  const famChat = heart && !scratch && tgSend && tgConf?.family?.chatId && env.HEART_KEY_DS ? createFamilyChat({ home: heartHome, stateDir: heartState,
    chats: [dsChat({ key: env.HEART_KEY_DS, model: env.FAMILY_MODEL || FAMILY_MODEL }), dsChat({ key: env.HEART_KEY_DS, model: FAMILY_BACKUP })],
    send: text => tgSend('sendMessage', { chat_id: tgConf.family.chatId, text }), typing: () => tgSend('sendChatAction', { chat_id: tgConf.family.chatId, action: 'typing' }).catch(() => {}),
    host, members: membersOf(tgConf.family.members),
    tz, feed: l => heart.feed(l), fallback: l => heart.feed(l), log: m => console.log(m) }) : null;
  // An outside world she also lives in (town.mjs): it reads her card and sends back what happened to her there.
  const townAllow = String(process.env.TOWN_ALLOW || '').split(',').map(x => x.trim()).filter(Boolean);
  const townKey = env.TOWN_KEY || '';
  const town = heart && !scratch && townKey ? createTown({ home: heartHome, host, town: idol.town || {}, hide: membersOf(tgConf?.family?.members).map(m => m.name), feed: l => heart.feed(l), tz, log: m => console.log(m) }) : null;
  const tg = heart && !scratch && tgConf?.token && tgConf?.chatId ? createTg({ home: heartHome, stateDir: heartState, api: tgSend, chatId: tgConf.chatId, botId: tgConf.botId || null, botUser: tgConf.botUser || '', names: [idol.name, idol.nameEn, idol.short].filter(Boolean), family: tgConf.family || null,
    onFamily: famChat ? m => famChat.hear(m) : null, onFamilySaid: famChat ? t => famChat.said(t) : null,
    tz, feed: l => heart.feed(l), log: m => console.log(m) }) : null;
  if (famChat) console.log('operators chat: direct');
  if (tg) {
    (async () => { for (;;) { try { await tg.poll(25); } catch (err) { console.log('tg poll:', err.message); await new Promise(r => setTimeout(r, 15e3)); } } })();
    setInterval(() => { tg.scan().catch(err => console.log('tg scan:', err.message)); }, 30e3).unref();
    console.log('tg: on');
  }
  // Her X replies (xreply.mjs): mentions and replies to her account, read and answered with the official API.
  const xr = xClient?.configured.user && env.X_REPLY !== '0' ? createXReply({ home: heartHome, stateDir: heartState,
    client: xClient, tz, feed: l => heart.feed(l), log: m => console.log(m) }) : null;
  if (xr) {
    const look = () => xr.poll().catch(err => console.log('xreply poll:', err.message));
    setTimeout(look, 30e3).unref(); setInterval(look, Number(env.X_REPLY_POLL_MS || 15 * 60e3)).unref();
    setInterval(() => { xr.scan().catch(err => console.log('xreply scan:', err.message)); }, 30e3).unref();
    console.log('xreply: on');
  }
  const filler = avatar.kind === 'vidu' ? createFiller({ idol, voice, dir: path.join(dataDir, 'fillers') }) : null;
  filler?.warm().then(n => console.log(`fillers ready: ${n}`), err => console.warn('fillers failed', err.message));
  const avatarView = () => { const v = relay?.view() || avatar.view(); return v?.rtc ? { ...v, rtc: null } : v; };
  const tickets = new Map();   // ip -> [times]; a visitor needs one ticket per visit, a few on reconnects
  // <data>/air.json {"until": ms} = an extra show right now (a special opening), read every 15 s.
  const airFile = path.join(dataDir, 'air.json');
  let air = { until: null, at: 0 };
  const extraShow = () => {
    if (Date.now() - air.at > 10e3) { try { air = { until: Number(JSON.parse(fs.readFileSync(airFile, 'utf8')).until) || null, at: Date.now() }; } catch { air = { until: null, at: Date.now() }; } }
    return air.until;
  };
  let openPending = false;   // on air, hello not said yet (keepOpen)
  const schedule = createSchedule({ windows: idol.schedule, tz, force: env.ON_AIR || (mode === 'test' ? 'on' : null), extra: extraShow });

  // One line: the subtitle goes out to every page at once, the avatar performs it (mock/live2d/simli: the page plays the mp3 and the
  // action effect; vidu: the line streams into the RTC picture), then a short breath before the next one.
  async function speak(line, e) {
    const id = randomBytes(6).toString('hex');
    if (e.kind === 'stage') await changeLook(e.stage);
    const r = await say(line, e, id);
    if (r?.skipped) return;
    const text = r?.cut ? `${saidPart(line.text, r.spokenMs)}……（看到弹幕，没说完）` : line.text;
    // what she was reading out goes to her heart first: given only her words, the heart took real items she had read
    // for things she made up
    const seen = line.text && seenOf(e);
    if (seen) heart?.feed(`【她刚刷到的】${seen.src}${seen.who ? ' ' + seen.who : ''}：${seen.text}`);
    if (line.text) heart?.feed(`【她刚说了】${text}`);
    if (showOpen && line.text) { herLines.push(line.inner ? `（心里：${line.inner}）${text}` : text); if (herLines.length > 60) herLines.shift(); }
    if (e.kind === 'close') endShow();
  }
  async function say(line, e, id) {
    const said = plainText(line.text);
    if (avatar.kind === 'mock' || avatar.kind === 'live2d' || avatar.kind === 'simli') {
      const r = await avatar.perform({ ...line, text: said, id, withVoice: live.viewers > 0 });
      world.say({ text: line.text, face: line.face, action: line.action, tone: line.tone, bgm: line.bgm, seen: seenOf(e), audio: r.audio, durationMs: r.durationMs, kind: e.kind, replyTo: e.kind === 'chat' ? e.chatId : null });
      await sleep(r.durationMs + (r.audio ? 1200 : 0));
      return;
    }
    // someone spoke to her while this musing was still being written: it goes unsaid, they come first
    if (CUTTABLE.has(e.kind) && waitingChat()) return { skipped: true };
    world.say({ text: line.text, face: line.face, action: line.action, tone: line.tone, bgm: line.bgm, seen: seenOf(e), kind: e.kind, replyTo: e.kind === 'chat' ? e.chatId : null });
    if (line.bgm) square?.bgm(line.bgm.url);
    // No Vidu right now (dropped and reconnecting, or out of credits): she keeps talking over her still picture, the
    // page plays the voice clip, like the placeholder avatar.
    if (!avatar.onAir) {
      const a = voice && (live?.viewers || 0) > 0 ? await voice.say(said, line.face, id, line.tone).catch(() => null) : null;
      world.w.line = { ...world.w.line, audio: a?.url || null, durationMs: a?.durationMs || 0 }; world.touch();
      await sleep((a?.durationMs || Math.max(3500, plainText(line.text).length * 180)) + (a ? 1200 : 0));
      return;
    }
    // a big move first (bigmoves.mjs): the feed plays the clip, then she says the line (the caption waits for it)
    const big = bigMoves?.pick(line, e);
    if (big && square.clip(big)) { showLog({ k: 'big', clip: big, kind: e.kind }); await sleep(bigMoves.holdMs); }
    const sn = seenOf(e);
    showLog({ k: 'say', text: plainText(line.text), face: line.face, action: line.action, beat: line.beat, tone: line.tone, inner: line.inner, kind: e.kind, to: e.name || null });
    square?.caption(plainText(line.text), e.kind === 'chat' ? e.name : '', sn ? `刷到${sn.src}${sn.who ? ' ' + sn.who : ''}：${sn.text}` : '', line.inner, idol.actions[line.action]?.fx);
    const named = square && market ? market.mentioned(plainText(line.text)) : [];
    if (named[0]) { focusCoin = named[0]; focusView = coinView(plainText(line.text), [named[0], ...Object.keys(ALIASES).filter(k => ALIASES[k] === named[0])]); pushFocus(); }
    const r = await avatar.perform({ ...line, text: said, id, cut: CUTTABLE.has(e.kind) ? waitingChat : null });
    await sleep(r.durationMs + (r.cut ? 300 : 800));
    return r;
  }
  // What she says to herself gives way, at her next pause, to someone who has just spoken to her.
  const CUTTABLE = new Set(['idle', 'self', 'more', 'post', 'news', 'learned', 'today', 'push', 'mood', 'segment']);
  const waitingChat = () => brain.queue.some(q => q.kind === 'chat' || q.kind === 'request' || q.kind === 'thanks');
  // Off air for real: hang up Vidu (billing stops) and put the stage look back for next time.
  function endShow() {
    if (schedule.onAir()) return;
    closeShow();
    relay?.stop();
    square?.stop();
    avatar.close().catch(() => {}).finally(() => avatar.offStage(false).catch(() => {}));
  }
  // New stage: on air she says she is off to change, the page shows the backstage curtain while the avatar reopens
  // on the new stage's look, then she comes back.
  async function changeLook(stage) {
    if (avatar.changesLook(stage) && idol.avatar.backstage?.length) {
      const lines = idol.avatar.backstage, text = lines[Math.floor(Math.random() * lines.length)];
      world.say({ text, face: '开心', action: '挥手', kind: 'backstage' });
      await avatar.perform({ text, action: '挥手', id: randomBytes(6).toString('hex') }).catch(() => {});
    }
    try {
      if (await avatar.setStage(stage) && relay) { await relay.stop(); relay.start(avatar.view().rtc).catch(err => status('relay', false, String(err.message || err).slice(0, 160))); }
    } catch (err) { status('avatar', false, 'backstage ' + String(err.message || err).slice(0, 140)); }
  }
  // After a show: one short model call turns tonight's chat into what she remembers and opens with tomorrow.
  let showOpen = false;
  const herLines = [];   // what she said tonight: her own thoughts and views are read from it after the show
  async function closeShow() {
    if (!showOpen) return;
    showOpen = false;
    const chats = world.today().chats.slice(-20).join(' / ');
    const mine = herLines.splice(0).slice(-30).join(' / ');
    let sum = {};
    if ((chats || mine) && routes.model.on) {
      try {
        // Her own reflection after the show: how the night felt, who she keeps thinking of, one thing to try next
        // time, and the one thing that stays with her, which joins her life (memory.experience).
        const reflect = idol.inner ? `,"felt":"用她自己的口气：今晚整体什么心情、为什么，25 字内","mood":"她下播时的心情，一个词","miss":[{"who":"弹幕里出现过的名字，原样写","why":"为什么惦记他，15 字内"}],"tryNext":"她下一场想试试的一件事，20 字内","life":"用她自己的口气写今晚最让她记住的一件事、以及它让她怎么想，40 字内，只写真的发生过的","fans":[{"who":"弹幕里出现过的名字，原样写","nick":"她今晚给他起的外号，没有就空","plan":"他说过要去做的事，15 字内，没有就空"}]` : '';
        const r = await ask([{ role: 'user', content: `这是${idol.name}今晚直播间的弹幕：${chats || '（没人说话）'}\n这是她自己今晚说的话（括号里是她当时心里想的）：${mine || '（没有）'}\n只输出一行 JSON：{"about":"今晚主要聊了什么，20 字内","best":"最好笑的一刻，20 字内，没有就空","promise":"她答应过谁下次做什么，20 字内，没有就空","thought":"用她自己的口气写一件她最近在琢磨的事，从今晚聊的内容里长出来，25 字内","changed":"她今晚改了主意的一件事，25 字内，没有就空","stances":[{"topic":"话题，6 字内","view":"她今晚明确说出的看法，20 字内"}]${reflect}}，stances、miss、fans 各最多 3 条，没有就空数组` }], { signal: AbortSignal.timeout(25000) });
        sum = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] || '{}');
      } catch (err) { console.warn('show summary failed', String(err.message || err).slice(0, 120)); }
    }
    const known = x => x?.who && memory.fan(x.who);   // only people who were really here
    memory.closeShow({ about: sum.about || null, best: sum.best || null, promise: sum.promise || null, felt: sum.felt || null, mood: brain.mood?.feel || sum.mood || null,
      miss: Array.isArray(sum.miss) ? sum.miss.filter(known) : [], tryNext: sum.tryNext || null, viewersPeak: Math.max(live?.viewers || 0, squareRoom.peak), listens: squareRoom.listens });
    if (sum.life) memory.experience({ text: sum.life });
    for (const x of Array.isArray(sum.fans) ? sum.fans.filter(known).slice(0, 3) : []) { if (x.nick) memory.nickname(x.who, x.nick); if (x.plan) memory.note(x.who, '说过要' + String(x.plan).replace(/^说过要/, '')); }
    memory.think({ thought: sum.thought || null, changed: sum.changed || null });
    for (const x of Array.isArray(sum.stances) ? sum.stances.slice(0, 3) : []) memory.stance({ topic: x?.topic, view: x?.view });
    memory.save();
  }
  // The market she can see (market.mjs, Binance public prices, read-only): majors, movers, coins viewers name. A jump
  // in a major is a line while she is on air; each tick settles any call she made against the live price.
  const market = mode === 'test' || env.MARKET_OFF === '1' ? null : createMarket({
    onMove: e => { if (schedule.onAir()) { brain.add(e); heart?.feed(`【盘面 ${heart.clock()}】${e.coin} 这 ${e.minutes} 分钟${e.pct > 0 ? '突然拉了' : '突然砸了'} ${Math.abs(e.pct).toFixed(1)}%，现在 ${e.price} 美元左右`); } },
    onTick: () => {
      world.touch();
      // without prices her heart has no view of its own; on air it gets the board every 10 min
      if (heart && schedule.onAir() && market.fresh && Date.now() - heartBoardAt >= 10 * 60e3) { heartBoardAt = Date.now(); heart.feed(`【盘面 ${heart.clock()}】${boardNote()}`); }
      square?.board(market.majors().map(c => ({ coin: c.coin, price: fmtPrice(c.price), pct: fmtPct(c.chg), up: c.chg >= 0 })));
      pushFocus();
      for (const c of memory.dueCalls()) {
        const p = market.get(c.subject)?.price;
        if (!p || !c.price) continue;
        const d = (p / c.price - 1) * 100;
        const done = memory.settle({ subject: c.subject, result: `${c.subject} 从 ${fmtPrice(c.price)} 到 ${fmtPrice(p)}（${fmtPct(d)}）`, right: c.dir === 'up' ? d > 0 : d < 0 });
        if (done) done.end = p;
        memory.save();
      }
    },
  });
  // The coin on the 16:9 feed's big card: the last one she talked about, else the top spot riser, else BTC; her own
  // words show only for the coin she named.
  let focusCoin = null, focusView = '', heartBoardAt = 0;
  function boardNote() {
    const one = c => `${c.coin} ${fmtPrice(c.price)}（${fmtPct(c.chg)}）`, m = market.movers('spot');
    return [market.majors().map(one).join('，'), m.up.length ? '现货涨得最猛：' + m.up.map(one).join('，') : '', m.down.length ? '跌得最狠：' + m.down.map(one).join('，') : ''].filter(Boolean).join('；');
  }
  async function pushFocus() {
    if (!square || !market?.fresh) return;
    const c = market.get(focusCoin) || market.get(market.movers('spot', 1).up[0]?.coin) || market.get('BTC');
    if (!c) return;
    const candles = await market.klines(c.coin).catch(() => []);
    square.focus({ coin: c.coin, price: fmtPrice(c.price), pct: fmtPct(c.chg), up: c.chg >= 0, view: c.coin === focusCoin ? focusView : '', candles });
  }
  // What she really sees in her day off air (heart.mjs daytime): the board, the busiest Square post and the newest news
  // item she has not seen yet, and today's hot list when it is new. Peeked, not used up: on air she may still bring
  // them up.
  const dayHad = new Set();
  function herDay() {
    const c = heart.clock(), out = [];
    if (market?.fresh) out.push(`【盘面 ${c}】${boardNote()}`);
    const post = posts?.peek().filter(x => !dayHad.has('p' + x.id)).sort((a, b) => b.comments - a.comments)[0];
    if (post) { dayHad.add('p' + post.id); out.push(`【刷广场 ${c}】${post.who}：${post.text}（${post.comments} 条评论）`); }
    const n = news?.peek().find(x => !dayHad.has('n' + x.id));
    if (n) { dayHad.add('n' + n.id); out.push(`【快讯 ${c}】${n.title}${n.sub ? '：' + n.sub.slice(0, 80) : ''}`); }
    // today's hot list (today.mjs), once per run: what everyone is talking about on Douyin, X, Square
    const td = today?.note();
    if (td && !dayHad.has('t' + today.stamp())) { dayHad.add('t' + today.stamp()); out.push(`【今天刷手机看到的 ${c}】抖音、推特、广场上大家都在聊：\n${td}`); }
    const local = new Date(Date.now() + tz * 3600e3), day = local.toISOString().slice(0, 10), mins = local.getUTCHours() * 60 + local.getUTCMinutes();
    // going online: if by mid-afternoon she has looked at nothing all day, one line saying she can; nothing more if she
    // doesn't want to
    const ws = web?.state(), looked = ws && ws.day === day && Object.keys(ws.calls || {}).length;
    if (web && !showOpen && !looked && mins >= 15 * 60 && mins < 18 * 60 && !dayHad.has('web' + day)) {
      dayHad.add('web' + day);
      out.push(`【上网 ${c}】你现在能自己上网：搜网页、打开网页，在推特上搜、看某个人最近发了什么，刷抖音热榜、在抖音上搜。今天还没出去看过，想看看外面在发生什么就去逛逛，看到有意思的记下来晚上聊；不想看也行。`);
    }
    // the futures crowd (CoinAnk), at most every half hour off air
    const ck = coinank?.feedLine(), slot = 'c' + Math.floor(Date.now() / 1800e3);
    if (ck && !dayHad.has(slot)) { dayHad.add(slot); out.push(ck); }
    return out;
  }
  // News, Square and X only on a real show: tests never poll them.
  const news = mode === 'test' || env.NEWS_OFF === '1' ? null : createNews();
  const learned = !idol.xlearn || !env.X_BEARER_TOKEN || !routes.model.on ? null : createXLearn({ file: path.join(dataDir, 'learned.json'), bearer: env.X_BEARER_TOKEN, accounts: idol.xlearn.accounts, everyMs: idol.xlearn.everyMs, airEveryMs: idol.xlearn.airEveryMs, bigPosts: idol.xlearn.bigPosts, roomPosts: idol.xlearn.roomPosts, onAir: () => schedule.onAir(), ask, pushFile: heartHome && !scratch ? path.join(heartHome, '币安在推', '官方最近在推.md') : null });
  const posts = news ? createSquareFeed() : null;
  // what happened today: Douyin, Google trends and the feeds above, boiled down twice a day (today.mjs)
  const today = news && idol.today !== false && routes.model.on ? createToday({ file: path.join(dataDir, 'today.json'), ask, tz, hours: idol.today?.hours,
    sources: () => ({ x: learned ? learned.peek?.().map(x => x.what) || [] : [], square: (posts?.peek() || []).sort((a, b) => b.comments - a.comments).slice(0, 8).map(p => `${p.who}：${p.text}`), news: (news?.peek() || []).slice(0, 8).map(n => n.title) }) }) : null;
  news?.start(); learned?.start(); posts?.start(); today?.start();
  // Who is watching (square.mjs watching): Square's own count of her room while she is on it, plus the site's. The
  // daytime radio is a Square live too, so it counts as well.
  const viewersNow = () => watching({ onSquare: !!square?.live || !!radio?.live, square: squareRoom.online, site: live?.viewers || 0 });
  // Her heart's page about a person (认识的人/<name>.md, written after shows): who they are, what happened between them.
  // Without it the mouth greets regulars like strangers. Read fresh at most once a minute per name; the body without
  // the title, newest lines first, kept short.
  const pages = new Map();
  const pageOf = name => {
    if (!heartHome || !name) return '';
    const n = String(name).trim(), hit = pages.get(n);
    if (hit && Date.now() - hit.at < 60e3) return hit.text;
    let text = '';
    try {
      const dir = path.join(heartHome, '认识的人');
      const f = fs.readdirSync(dir).find(x => x.replace(/\.md$/, '').trim().toLowerCase() === n.toLowerCase());
      if (f) text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^#[^\n]*\n/, '').split(/\n\s*\n/).map(x => x.trim()).filter(Boolean).reverse().join(' ').replace(/\s+/g, ' ');
    } catch {}
    pages.set(n, { at: Date.now(), text });
    if (pages.size > 2000) pages.delete(pages.keys().next().value);
    return text;
  };
  // What Binance is pushing, from her heart's home (xlearn keeps the official list, she keeps her own)
  const pushes = heartHome && !scratch ? createPushTalk({ dir: path.join(heartHome, '币安在推') }) : null;
  const brain = createBrain({ idol, world, ask, speak, direct: mouthDirect, memory, memes, news, learned, posts, today, pushes, market, pageOf,
    act: async line => { avatar.move?.(line.action); if (showOpen && line.inner) herLines.push(`（心里：${line.inner}，没说话）`); await sleep(6000); }, viewers: viewersNow, alone: () => !!square?.live, heart: () => heart?.note(), onAir: () => schedule.onAir() && !openPending, status, idleMs: Number(env.IDLE_MS || idol.idleMs || 60000), timeoutMs: reply.timeoutMs, longTimeoutMs: reply.longTimeoutMs });

  // Going on and off air: open the avatar session (Vidu bills from here) and say hello; say goodbye, then close it.
  // Square watches the whole show once the feed is set up, so she stays connected for it (it wants a steady stream).
  const watched = avatar.kind === 'vidu' && idol.watchedOnly ? (gate => () => gate() || !!square?.configured())(watchGate({ ...idol.watchedOnly, viewers: () => live?.viewers || 0 })) : () => true;
  let wasOnAir = null;
  // The booked Square hours (idol.live): the hello waits for the room to open, the goodbye comes before Square cuts.
  // Only the nightly booked show (its timer forces ON_AIR=on); an extra show says hello at once.
  const cue = () => mode === 'test' || !idol.live || schedule.info().forced !== 'on' ? null : showCue(Date.now(), { tz, ...idol.live });
  function keepOpen() {
    if (!openPending || !schedule.onAir() || cue() === 'wait') return;
    openPending = false;
    brain.add({ kind: 'open', viewers: live?.viewers || 0 });
  }
  async function watchSchedule() {
    if (cue() === 'end') schedule.force('off');
    const on = schedule.onAir();
    if (on === wasOnAir) return;
    const first = wasOnAir === null;
    wasOnAir = on;
    world.touch();
    if (on) {
      if (watched()) try {
        await avatar.open();
        if (relay) relay.start(avatar.view().rtc).catch(err => status('relay', false, String(err.message || err).slice(0, 160)));
      } catch (err) { status('avatar', false, String(err.message || err).slice(0, 160)); }
      // A restart in the middle of tonight's show (a release) carries on the same show: no second hello, no new record.
      const last = memory.m.shows[0];
      const resumed = first && last && last.to === null && Date.now() - last.from < 4 * 3600e3;
      if (!showOpen) { if (!resumed) { memory.openShow(); squareRoom.reset(); } showOpen = true; }
      if (!resumed && (!first || mode !== 'test')) openPending = true;
      keepOpen();
    } else if (!first) {
      openPending = false;
      const next = schedule.info().nextAt;
      brain.add({ kind: 'close', next: next ? clockIn(next, tz) : '明天' });
      // Safety net: the goodbye normally ends the show itself; never leave Vidu billing past this.
      setTimeout(() => { if (!schedule.onAir()) endShow(); }, 30e3);
    }
  }
  const scheduleTimer = setInterval(() => { watchSchedule(); keepOpen(); keepAvatar(); keepSquare(); checkCredits(); if (schedule.onAir()) voice?.warm?.(); }, 15e3);
  // The Square feed follows her picture: starts once Vidu is up on air, stops if the address is taken away.
  function keepSquare() {
    // the show's music starts once the feed is live, and if the page ever loses it (a restart), it comes back
    if (square?.live && showSongs && (!showSongs.current || Date.now() - showSongs.current.at > (showSongs.current.dur + 30) * 1000)) playNextSong();
    if (!square) return;
    if (square.on && !square.configured()) { square.stop(); return; }
    if (!square.on && square.configured() && schedule.onAir() && avatar.onAir) square.start().catch(err => status('square', false, String(err.message || err).slice(0, 160)));
    radio?.keep(schedule.onAir() || square.on).catch(err => status('radio', false, String(err.message || err).slice(0, 160)));
  }
  watchSchedule();

  // An idol with watchedOnly keeps Vidu connected only while someone is in the room: nobody for graceMs and she hangs
  // up and carries on over her still picture; the first viewer to open the stream brings her back in about 5 s. Once
  // she is pushed to Binance Square, that audience counts here as well. If Vidu drops the session (force_hangup, the
  // 2-hour cap, a network blip) she reconnects within about 15-30 s.
  let lastTry = 0, reconnecting = false;
  async function keepAvatar(join = false) {
    if (avatar.kind !== 'vidu' || !schedule.onAir() || reconnecting) return;
    if (!watched()) {
      if (!avatar.onAir) return;
      reconnecting = true;
      try { relay?.stop(); await avatar.close(); console.log('vidu: nobody watching, hung up'); } catch {} finally { reconnecting = false; }
      return;
    }
    if (avatar.onAir || Date.now() - lastTry < (join ? 5e3 : 30e3)) return;
    lastTry = Date.now(); reconnecting = true;
    try {
      await avatar.open();
      if (relay) relay.start(avatar.view().rtc).catch(err => status('relay', false, String(err.message || err).slice(0, 160)));
    } catch (err) { status('avatar', false, 'reconnect ' + String(err.message || err).slice(0, 140)); }
    finally { reconnecting = false; }
  }
  // Low credits only raise a warning in /api/health; nothing is switched off because of it.
  let credits = { n: null, at: 0 };
  async function checkCredits() {
    if (!avatar.credits || Date.now() - credits.at < 5 * 60e3) return;
    credits = { n: await avatar.credits().catch(() => null), at: Date.now() };
    // Kept off the public room snapshot; only /api/health carries it.
    if (credits.n != null && credits.n < Number(env.VIDU_WARN_CREDITS || 1800)) console.warn(`vidu credits low: ${credits.n} (about ${Math.round(credits.n / 60)} min on air)`);
  }

  const auth = createAuth();
  const nicks = new Map();   // guest id -> the nickname they picked
  // 1-12 characters, no links, nothing that passes for staff, an exchange's official account or the host herself.
  const ownNames = [idol.name, idol.nameEn, idol.short].filter(Boolean).map(x => String(x).toLowerCase());
  const nickOf = raw => {
    const n = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 12);
    if (!n || /https?:|www\.|\.(com|io|xyz)|官方|客服|管理|admin|binance|币安/i.test(n) || ownNames.some(o => n.toLowerCase().includes(o))) return null;
    return n;
  };
  const lastChat = new Map(), lastReq = new Map(), lastChatIp = new Map();
  // Comments read off her Binance Square room (the ops reader posts them with the key in <data>/square-ingest.key);
  // they join the same chat list and queue as the web room's, tagged 广场 on the page.
  const ingestFile = path.join(dataDir, 'square-ingest.key');
  if (!fs.existsSync(ingestFile)) { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(ingestFile, randomBytes(18).toString('base64url'), { mode: 0o600 }); }
  const ingestKey = fs.readFileSync(ingestFile, 'utf8').trim();
  const squareSeen = new Map();
  // Guests: free uses per guest, and new guest identities per IP per hour.
  const guestLeft = new Map(), guestIps = new Map();
  const GUEST_PER_IP_HOUR = Number(env.GUEST_PER_IP_HOUR || 30);
  const leftOf = addr => guestLeft.get(addr) || { requests: 0, chats: 0 };

  function snapshot() {
    const w = world.w;
    return {
      time: Date.now(), mode,
      idol: { id: idol.id, name: idol.name, nameEn: idol.nameEn, short: idol.short, square: idol.square?.handle || idol.square?.url ? idol.square : null, x: idol.x || null, tg: idol.tg?.link ? idol.tg : null, site: idol.site || '', lang: idol.lang, shape: idol.avatar.shape || 'tall', actions: Object.fromEntries(Object.entries(idol.actions).filter(([, a]) => !a.daily).map(([k, a]) => [k, a.fx])) },
      stage: w.stage, stages: STAGES.map(s => ({ key: s.key, name: s.name })),
      mood: w.mood, moodName: MOODS[w.mood],
      onAir: schedule.info(), avatar: avatarView(), schedule: idol.schedule, tz,
      line: w.line, chat: w.chat.slice(0, 24), feed: w.feed.slice(0, 20),
      diaryDates: w.diary.map(d => d.date),
      viewers: live?.viewers || 0,
      memo: { regulars: Object.values(memory.m.fans).filter(f => f.visits >= 2).length, shows: memory.m.shows.filter(s => s.to).length },
      market: market?.board() || null,
      calls: { score: memory.score(), list: memory.m.calls.filter(c => c.dir).slice(0, 3).map(c => ({ coin: c.subject, dir: c.dir, price: c.price, end: c.end ?? null, at: c.at, due: c.due, right: c.right })) },
      // Keep the reason with the state: 'down' on its own cannot be debugged from outside.
      routes: Object.fromEntries(Object.entries(routes).map(([k, r]) => [k, r.on ? (r.ok === false ? 'down' : 'ok') : 'off'])),
      why: Object.fromEntries(Object.entries(routes).filter(([, r]) => r.ok === false && r.err).map(([k, r]) => [k, r.err])),
    };
  }
  live = liveRoom({ build: snapshot, version: world.version, tickMs: 500 });

  // Diary: written once a day at 23:50 in the host's time zone (and on demand in test mode), from the day's tally.
  async function writeDiary() {
    const d = world.today();
    let text;
    try {
      const r = await ask([{ role: 'system', content: brain.persona }, { role: 'user', content: diaryPrompt(idol, world.w, d) }], { long: true, signal: AbortSignal.timeout(40000) });
      text = takeInner(r.text).text.replace(/^[\[【][^\]】]{1,4}[\]】]/, '').replace(/[（(]\s*(共|全文)?\s*\d+\s*字\s*[）)]\s*$/, '').trim();
      text = fitLength(text);
      status('model', true);
    } catch (err) {
      status('model', false, String(err.message || err));
      text = '今天的直播结束了。来的人不多不少，聊的东西有真有假，反正我都记下了。明天见。';
    }
    world.addDiary({ date: d.date, text });
    brain.add({ kind: 'diaryNote', preview: text.slice(0, 30) });
    return { date: d.date, text };
  }
  const diaryTimer = setInterval(() => {
    const local = new Date(Date.now() + tz * 3600e3), date = local.toISOString().slice(0, 10);
    if (local.getUTCHours() === 23 && local.getUTCMinutes() >= 50 && !world.w.diary.some(x => x.date === date)) writeDiary();
  }, 60e3);
  const saveTimer = setInterval(() => { world.save(); memory.save(); }, 5000);

  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req, max = 8192) => new Promise((resolve, reject) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > max) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('bad json')); } });
  });
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
  function serveFile(res, base, rel, cache) {
    const file = path.join(base, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  const server = createServer(async (req, res) => {
    // Never new URL(req.url, base): scanners send //%2e%2e%2f%2eenv, the leading // reads as a host and the throw
    // would take the whole process down.
    let url, p;
    try { url = new URL('http://x' + (req.url?.startsWith('/') ? req.url : '/' + req.url)); p = url.pathname; }
    catch { return json(res, 400, { error: 'bad path' }); }
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
    const fromReader = () => keyOk(req.headers['x-square-key'], ingestKey);   // the ops scripts, with <data>/square-ingest.key
    try {
      if (p === '/api/simli/session') {
        if (!isLocalSimliRequest(req)) return json(res, 403, { error: 'Simli trials are only available in the local operator browser' });
        if (req.method !== 'POST' && req.method !== 'DELETE') { res.setHeader('Allow', 'POST, DELETE'); return json(res, 405, { error: 'Use POST or DELETE for a Simli session' }); }
        if (!simli) return json(res, 409, { error: 'The Simli avatar is not selected' });
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Send a JSON request' });
        const body = await readBody(req, 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Send a JSON object' });
        if (req.method === 'DELETE') return json(res, 200, simli.release(body.leaseId));
        const controller = new AbortController(), cancel = () => { if (!res.writableEnded) controller.abort(); };
        req.once('aborted', cancel); res.once('close', cancel);
        try {
          const session = await simli.create({ signal: controller.signal });
          if (!res.destroyed) return json(res, 200, session);
        } finally { req.off('aborted', cancel); res.off('close', cancel); }
        return;
      }
      if (p === '/api/state') {
        const snap = live.current();
        const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
        if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' }); return res.end(live.gzipped(snap)); }
        res.writeHead(200, headers); return res.end(snap.json);
      }
      if (p === '/api/stream') { const r = live.subscribe(res, ip); keepAvatar(true); return r; }
      if (p === '/api/rtc-ticket') {
        if (!room || !avatar.onAir) return json(res, 409, { error: 'not on air' });
        const now = Date.now(), hits = (tickets.get(ip) || []).filter(t => now - t < 10 * 60e3);
        if (hits.length >= 20) return json(res, 429, { error: 'too many' });
        hits.push(now); tickets.set(ip, hits);
        if (tickets.size > 5000) for (const [k, v] of tickets) if (now - v.at(-1) > 10 * 60e3) tickets.delete(k);
        res.setHeader('Cache-Control', 'no-store');
        return json(res, 200, room.viewer());
      }
      // from outside (the proxy sets X-Real-IP) only the on/off parts; voice id, credits and spend stay on the box
      if (p === '/api/health') return json(res, 200, ((h) => req.headers['x-real-ip'] ? (({ voice, viduCredits, modelSpend, model, ...pub }) => pub)(h) : h)({
        mode, viewers: live.viewers, stage: STAGES[world.w.stage]?.name, lastLineAt: world.w.line?.at || null,
        queue: brain.queue.length, routes, modelProvider: reply.provider, model: reply.model, avatar: avatar.kind, viduCredits: credits.n, viduCreditsLow: credits.n != null && credits.n < Number(env.VIDU_WARN_CREDITS || 1800),
        square: square ? { configured: square.configured(), live: square.live, online: squareRoom.online, pv: squareRoom.pv, peak: squareRoom.peak } : null,
        radio: radio ? { wanted: radio.wanted(), on: radio.on, live: radio.live, answered: radio.answered, queue: radio.queue } : null,
        x: xClient ? { post: xClient.configured.user, read: xClient.configured.read, replies: !!xr } : null,
        heart: !!heart, onAir: schedule.info(), ...(simli && isLocalSimliRequest(req, { requireOrigin: false }) ? { simli: simli.health() } : {}),
        voice: voice ? { model: voice.provider === 'doubao' ? doubaoResource(voice.voiceId) : VOICE.model, charsToday: voice.used, capChars: voice.dailyChars, ...(voice.provider === 'doubao' ? { rmbToday: +voice.rmb.toFixed(3) } : { usdToday: +voice.usd.toFixed(3) }) } : null,
        modelSpend: { calls: brain.spend.calls, fails: brain.spend.fails, usd: reply.costKnown ? +brain.spend.usd.toFixed(4) : null, costKnown: reply.costKnown, billing: reply.provider === 'codex' ? 'codex' : 'api' },
      }));
      if (p === '/api/diary') {
        const d = world.w.diary.find(x => x.date === url.searchParams.get('date')) || world.w.diary[0];
        return json(res, 200, d || null);
      }
      if (p === '/api/me') {
        const addr = auth.who(url.searchParams.get('token'));
        if (!addr) return json(res, 401, { error: '没有登录' });
        return json(res, 200, { address: addr, who: nicks.get(addr) || whoOf(addr), guest: true, left: leftOf(addr), tier: { key: 'guest', name: '游客' } });
      }
      if (req.method === 'POST' && p === '/api/guest') {
        const now = Date.now(), hits = (guestIps.get(ip) || []).filter(t => now - t < 3600e3);
        if (hits.length >= GUEST_PER_IP_HOUR) return json(res, 429, { error: '这台设备进来的游客太多了，过一会儿再来' });
        hits.push(now); guestIps.set(ip, hits);
        if (guestIps.size > 5000) for (const [k, v] of guestIps) if (now - v.at(-1) > 3600e3) guestIps.delete(k);
        const nick = nickOf((await readBody(req)).name);
        if (!nick) return json(res, 400, { error: '换个昵称：1 到 12 个字，不能带链接或“官方”“客服”' });
        const r = auth.guest();
        guestLeft.set(r.address, { ...idol.guest });
        nicks.set(r.address, nick); memory.seen(nick); if (nicks.size > 50000) nicks.delete(nicks.keys().next().value);
        if (guestLeft.size > 50000) guestLeft.delete(guestLeft.keys().next().value);
        return json(res, 200, { ...r, who: nick, left: { ...idol.guest } });
      }
      if (req.method === 'POST' && p === '/api/request') {
        const body = await readBody(req);
        const addr = auth.who(body.token);
        if (!addr || !isGuest(addr)) return json(res, 401, { error: '先起个昵称进来' });
        const action = String(body.action || '');
        if (!idol.actions[action] || idol.actions[action].daily) return json(res, 400, { error: '没有这个动作' });
        if (!schedule.info().onAir) return json(res, 409, { error: '她现在没在直播' });
        const left = leftOf(addr);
        if (left.requests <= 0 || Date.now() - (lastReq.get(addr) || 0) < idol.requestGapMs) return json(res, 429, { error: '点太快了，等她做完这个' });
        if (brain.queue.filter(q => q.kind === 'request').length >= 6) return json(res, 429, { error: '点播排满了，过一会儿再点' });
        lastReq.set(addr, Date.now());
        left.requests--;
        const name = nicks.get(addr) || null;
        const item = world.chat({ addr, text: `点播「${action}」`, request: action, who: name, from: 'web' });
        brain.add({ kind: 'request', chatId: item.id, addr, name, action, tier: 'guest', tierName: '游客', rank: null });
        return json(res, 200, { ok: true, id: item.id, left });
      }
      // The outside world's door (town.mjs): GET her card + mood, POST { events: [...] } what happened to her there.
      if (p === '/api/town/host' || p === '/api/town/host/events') {
        if (!townAllowed(townAllow, req.headers['x-real-ip'])) return json(res, 403, { error: 'not from the world' });
        if (!town || !keyOk(req.headers['x-town-key'], townKey)) return json(res, 403, { error: 'bad key' });
        if (req.method === 'GET' && p === '/api/town/host') return json(res, 200, town.card());
        if (req.method === 'POST' && p === '/api/town/host/events') { const r = town.take((await readBody(req, 64000))?.events); return json(res, r.status || 200, r); }
        return json(res, 405, { error: 'GET /api/town/host or POST /api/town/host/events' });
      }
      // The Square extension also reports which addresses Square's page uses for its chat, so the reading can move to
      // a server. Appends to <DATA_DIR>/square-probe.jsonl; same key as comments.
      if (req.method === 'POST' && p === '/api/square/probe') {
        if (!fromReader()) return json(res, 403, { error: 'bad key' });
        const body = await readBody(req, 64000);
        const pf = path.join(dataDir, 'square-probe.jsonl');
        fs.appendFileSync(pf, JSON.stringify({ at: Date.now(), ...body }).slice(0, 64000) + '\n', { mode: 0o600 }); fs.chmodSync(pf, 0o600);
        return json(res, 200, { ok: true });
      }
      // The host account's Binance login (cookies from the extension) is kept on the server so the ops scripts can
      // start/end the show and read comments. Owner-only file, overwritten on each send; never logged.
      if (req.method === 'POST' && p === '/api/square/session') {
        if (!fromReader()) return json(res, 403, { error: 'bad key' });
        const body = await readBody(req, 200000);
        const sf = path.join(dataDir, 'square-session.json');
        fs.writeFileSync(sf, JSON.stringify({ at: Date.now(), ...body }), { mode: 0o600 }); fs.chmodSync(sf, 0o600);
        return json(res, 200, { ok: true, cookies: (body.cookies || []).length });
      }
      // Each Square live has its own push key; the extension or the ops keeper reads it and this writes it where the
      // feed looks (same file as deploy/set-square.sh). Ignored if unchanged.
      if (req.method === 'POST' && p === '/api/square/push') {
        if (!fromReader()) return json(res, 403, { error: 'bad key' });
        const { url: pushUrl, key, restart } = await readBody(req, 4000);
        if (!/^rtmps?:\/\/[^\s]+$/.test(pushUrl || '') || !/^[\w?=&.-]{8,200}$/.test(key || '')) return json(res, 400, { error: 'bad push' });
        const qf = path.join(dataDir, 'square.json');
        let cur = {}; try { cur = JSON.parse(fs.readFileSync(qf, 'utf8')); } catch {}
        if (cur.url === pushUrl && cur.key === key) {
          // the keeper hands the same key again with restart when Square stops getting a picture
          if (restart && square?.on) { console.log('square feed restarting on request'); square.stop().catch(() => {}); }
          return json(res, 200, { ok: true, same: true, restarted: !!(restart && square) });
        }
        fs.writeFileSync(qf, JSON.stringify({ url: pushUrl, key, size: cur.size || '720x1280' }), { mode: 0o600 });
        console.log('square push key updated');
        // A new live has a new key; a feed still pushing to the old one leaves the new live black. Stop it; keepSquare
        // starts it again on the new key within 15 s.
        if (square?.on) { console.log('square feed restarting on the new key'); square.stop().catch(() => {}); }
        return json(res, 200, { ok: true });
      }
      // The radio between shows: the ops scripts say when its live is up or down, and hand over Binance's latest
      // activity announcements, the only thing she answers activity questions from.
      if (req.method === 'POST' && (p === '/api/square/radio' || p === '/api/square/facts')) {
        if (!fromReader()) return json(res, 403, { error: 'bad key' });
        const body = await readBody(req, p === '/api/square/facts' ? 16000 : 2000);
        if (p === '/api/square/radio') {
          fs.writeFileSync(path.join(dataDir, 'radio.json'), JSON.stringify({ on: !!body.on, at: Date.now() }));
          console.log('radio ' + (body.on ? 'on' : 'off') + ' from ops');
          keepSquare();
          return json(res, 200, { ok: true, on: !!body.on });
        }
        // A reverse proxy may cap a request at 16 KB, so facts come a few at a time: the first with reset, the rest appended.
        const ff = path.join(dataDir, 'facts.json');
        let have = []; if (!body.reset) try { have = JSON.parse(fs.readFileSync(ff, 'utf8')).items || []; } catch {}
        const items = have.concat((Array.isArray(body.items) ? body.items : []).map(f => ({ title: String(f.title || '').slice(0, 120), date: Number(f.date) || 0, body: String(f.body || '').slice(0, 2400) })).filter(f => f.title)).slice(0, 30);
        fs.writeFileSync(ff, JSON.stringify({ at: Date.now(), items }));
        return json(res, 200, { ok: true, n: items.length });
      }
      // Her own posts (outbox.mjs): the ops poster takes what she wrote and posts it with Square's OpenAPI, then says
      // how it went.
      if (p === '/api/square/outbox' || p === '/api/square/outbox/done') {
        if (!fromReader()) return json(res, 403, { error: 'bad key' });
        if (!outbox) return json(res, 200, { items: [] });
        if (req.method === 'GET' && p === '/api/square/outbox') return json(res, 200, { items: outbox.take() });
        if (req.method === 'POST' && p === '/api/square/outbox/done') return json(res, 200, { ok: outbox.settle(await readBody(req, 4000)) });
      }
      if (req.method === 'POST' && p === '/api/square/comments') {
        if (!fromReader()) return json(res, 403, { error: 'bad key' });
        const items = cleanComments((await readBody(req, 16000)).items, { seen: squareSeen, nickOf });
        for (const { name, text } of items) {
          const addr = 'guest-sq-' + createHash('sha256').update(name).digest('hex').slice(0, 12);
          memory.seen(name);
          const item = world.chat({ addr, text, who: name, from: 'square' });
          if (radio?.on) { radio.chat(name, item.text); showLog({ k: 'chat', who: name, text: item.text, radio: true }); continue; }
          const asked = square?.live ? showSongs?.ask(name, item.text) : null;
          if (asked?.id && !showSongs.current?.by) playNextSong();
          brain.add({ kind: 'chat', chatId: item.id, addr, name, text: item.text + songNote(asked), tier: 'guest', tierName: '游客', rank: null, from: 'square' });
          heart?.feed(`【直播间 ${heart.clock()}】${name}：${item.text}`);
          showLog({ k: 'chat', who: name, text: item.text });
        }
        if (items.length) {
          status('chat', true); heardAt = Date.now();
          // her face and a sound react together the moment it lands; without one she just glances at the screen
          const f = avatar.free && filler?.pick(items.at(-1).text);
          if (f && avatar.blurt?.(f.pcm, f.text, f.act)) showLog({ k: 'blurt', text: f.text, action: f.act });
          else avatar.notice?.();
        }
        return json(res, 200, { ok: true, took: items.length });
      }
      // Her Square room's own numbers and walk-ins: the ops room reader takes them off the room page's chat socket, with
      // a slower poll as the backup. A walk-in is greeted by name (brain folds a crowd).
      if (req.method === 'POST' && p === '/api/square/room') {
        if (!fromReader()) return json(res, 403, { error: 'bad key' });
        const { joins, thanks, ended, warned } = squareRoom.take(await readBody(req, 16000), nickOf);
        for (const name of joins) showLog({ k: 'join', who: name, online: viewersNow() });
        for (const x of thanks) showLog({ k: 'thanks', act: x.act, who: x.name || null, what: x.what || null });
        for (const name of joins) { memory.seen(name); brain.add({ kind: 'join', name, viewers: viewersNow(), from: 'square' }); heart?.feed(`【直播间 ${heart.clock()}】${name} 进来了，现在 ${viewersNow()} 个人在看`); }
        const TH = { follow: '关注了她', gift: '送了礼物', tip: '打赏了', red: '发了红包' };
        for (const x of thanks) { if (x.name) memory.seen(x.name); brain.add({ kind: 'thanks', act: x.act, name: x.name, what: x.what, from: 'square' }); heart?.feed(`【直播间 ${heart.clock()}】${x.name || '有人'} ${TH[x.act]}${x.what ? '：' + x.what : ''}`); }
        if (thanks.length) console.log('square room: thanks', thanks.map(x => x.act).join(','));
        // Square warns a live it thinks breaks a rule: logged and on the status page for the operators, not for her
        if (warned) { console.log('square room: Square sent a LIVE_WARNING'); status('squareWarning', false, 'Square sent a live warning ' + new Date().toISOString()); }
        status('squareRoom', !ended, ended ? 'Square says the live ended' : undefined);
        if (ended) console.log('square room: Square says the live ended');
        return json(res, 200, { ok: true, online: squareRoom.online, took: joins.length });
      }
      if (req.method === 'POST' && p === '/api/chat') {
        const body = await readBody(req);
        const addr = auth.who(body.token);
        if (!addr || !isGuest(addr)) return json(res, 401, { error: '先起个昵称进来' });
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { error: '说点什么再发' });
        if (text.length > 80) return json(res, 400, { error: '一条最多 80 个字' });
        const left = leftOf(addr);
        if (left.chats <= 0 || Date.now() - (lastChat.get(addr) || 0) < 8000) return json(res, 429, { error: '发太快了，8 秒一条' });
        // one device with many guests could still flood her: per IP at most one line every 3 s
        if (Date.now() - (lastChatIp.get(ip) || 0) < 3000) return json(res, 429, { error: '发太快了，等一下' });
        lastChatIp.set(ip, Date.now()); if (lastChatIp.size > 20000) lastChatIp.delete(lastChatIp.keys().next().value);
        left.chats--;
        lastChat.set(addr, Date.now());
        const name = nicks.get(addr) || null;
        if (name) memory.seen(name);
        const item = world.chat({ addr, text, who: name, from: 'web' });
        brain.add({ kind: 'chat', chatId: item.id, addr, name, text: item.text, tier: 'guest', tierName: '游客', rank: null });
        heart?.feed(`【网页直播间 ${heart.clock()}】${name || '游客'}：${item.text}`);
        heardAt = Date.now(); avatar.notice?.();
        status('chat', true);
        return json(res, 200, { ok: true, id: item.id });
      }
      if (p.startsWith('/api/test/')) {
        if (mode !== 'test') return json(res, 404, { error: 'not found' });
        const body = req.method === 'POST' ? await readBody(req) : {};
        if (p === '/api/test/diary') return json(res, 200, await writeDiary());
        // End or start the show now: on -> off plays the goodbye.
        if (p === '/api/test/air') { schedule.force(body.on ? 'on' : 'off'); await watchSchedule(); return json(res, 200, { ok: true, onAir: schedule.onAir() }); }
        return json(res, 404, { error: 'not found' });
      }
      // The playlist changes every second; segments never change once written.
      if (p.startsWith('/hls/') && serveFile(res, path.join(dataDir, 'hls'), p.slice(5), p.endsWith('.m3u8') ? 'no-cache' : 'public, max-age=60')) return;
      if (p.startsWith('/bgm/') && p.endsWith('.m4a') && serveFile(res, path.join(dataDir, 'bgm'), p.slice(5), 'public, max-age=86400')) return;
      if (p.startsWith('/audio/') && serveFile(res, path.join(dataDir, 'audio'), p.slice(7), 'public, max-age=3600')) return;
      if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
      const rel = p === '/' ? 'index.html' : p.slice(1);
      if (serveFile(res, path.join(ROOT, 'public'), rel, rel.startsWith('art/') && !rel.endsWith('.json') ? 'public, max-age=86400' : 'no-cache')) return;
      json(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof SimliError) { if (!res.destroyed) return json(res, err.status, { error: err.message }); return; }
      if (err instanceof AuthError) return json(res, 400, { error: err.message });
      if (err.message === 'bad json') return json(res, 400, { error: '请求格式不对' });
      if (err.message === 'too large') return;
      console.error(p, err);
      if (!res.headersSent) json(res, 500, { error: '服务器出错了' });
    }
  });

  market?.start();
  brain.start();
  // Waits for the Vidu hangup to go out: Vidu bills by connected time, so exiting before it would leave her billing.
  const shutdown = async () => {
    world.save(); memory.save();
    simli?.close();
    const brainStopped = brain.stop(), repliesClosed = reply.close();
    market?.stop(); live.stop(); square?.stop(); radio?.close().catch?.(() => {}); clearInterval(diaryTimer); clearInterval(saveTimer); clearInterval(scheduleTimer); server.close();
    await Promise.race([Promise.all([brainStopped, repliesClosed, relay?.stop(), avatar.close(), outbox?.flush()]).catch(() => {}), sleep(3000)]);
  };
  return { server, world, brain, live, avatar, schedule, shutdown, routes };
}

// Compare real paths: the app may run from a current -> releases/<ver> symlink.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.PORT || 4370);
  const app = await start();
  app.server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`livehost (${process.env.IDOL || 'example'}, ${process.env.MODE || 'show'}) on http://127.0.0.1:${port}  model=${app.routes.model.on} voice=${app.routes.voice.on} avatar=${app.avatar.kind}`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.shutdown(); process.exit(0); });
}
