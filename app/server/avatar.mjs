// The idol's face on screen: one interface, several drivers, so the rest of the server never cares which is plugged in.
//   open() / close()                                              start and end a broadcast (Vidu bills while open)
//   perform({ text, face, action, id }) -> { audio, durationMs }   say one line (and do one action), resolve when done
//   setStage(stage)                                               new career stage: her next complete look (on air: backstage change)
//   offStage(on)                                                  忘关麦: wear the off-stage look (on air: reconnect) / back to stage
//   view()                                                        what the page should show (sent in the room snapshot)
//
//   mock  placeholder picture; the page plays the action as an effect and the voice (fal MiniMax mp3) when available.
//   vidu  Vidu S2 Avatar *Component* (see Vidu's live-avatar component docs): we send our own
//         voice as 24 kHz mono s16le PCM over the WebSocket plus the line (type 10) and an action text (type 9); Vidu
//         renders her into an RTC channel the page watches.
//         With our action library bound (VIDU_ACTION_LIB / idol.avatar.viduActionLib, synced by
//         tools/vidu-actions.mjs) type 9 carries just the action name for Vidu to match; otherwise the `vidu` text.
import fs from 'node:fs';
import path from 'node:path';
import { plainText } from './voice.mjs';
import { live2dConfig } from './live2d.mjs';
import { simliPublicConfig } from './simli.mjs';

// Each stage is one complete picture of her in that stage's outfit and place (clothes pasted onto a face look fake). The page shows public/art/<idol>/looks/<key>.jpg; Vidu gets the same picture uploaded once as an
// avatar asset (tools/vidu-looks.mjs -> idols/<idol>/vidu-looks.json -> idol.avatar.viduLooks).
// `key` overrides the stage's look: 'off' is her off-stage picture for the 忘关麦 (forgot-the-mic) bit after the show.
export function lookSrc(idol, s, dir, key = idol.stages[s]?.key) {
  const k = key, f = dir && k && path.join(dir, `${k}.jpg`);
  // ?v=<mtime>: static files are cached for a day, so a redrawn look must get a new URL.
  return f && fs.existsSync(f) ? `/art/${idol.id}/looks/${k}.jpg?v=${Math.floor(fs.statSync(f).mtimeMs / 1000)}` : idol.avatar.image;
}
export const lookAvatar = (idol, s, env = {}, key = idol.stages[s]?.key) => idol.avatar.viduLooks?.[key] || env.VIDU_AVATAR_ID || idol.avatar.viduAvatarId;

// quiet(): ms since anyone last said anything in the room, so an idle stretch can turn into her drifting off.
export function createAvatar({ idol, kind = 'mock', voice = null, status, env = {}, room = null, lookDir = null, quiet = () => 0 }) {
  if (kind === 'vidu') return viduAvatar({ idol, voice, status, env, room, lookDir, quiet });
  if (kind === 'simli') {
    const simli = simliPublicConfig(env);
    const local = mockAvatar({ idol, voice, status, lookDir });
    status?.('avatar', simli.configured, simli.configured ? undefined : 'Simli credentials missing');
    return { ...local, kind: 'simli', view: () => ({ ...local.view(), kind: 'simli', simli }) };
  }
  if (kind === 'live2d') {
    const live2d = live2dConfig(idol, env);
    const local = mockAvatar({ idol, voice, status, lookDir });
    let cue = null, sequence = 0;
    const move = action => { if (live2d.motions[action]) cue = { id: ++sequence, action }; };
    const notice = action => {
      const available = (action ? [action] : idol.notice || []).filter(name => live2d.motions[name]);
      if (available.length) move(available[Math.floor(Math.random() * available.length)]);
    };
    return {
      ...local, kind: 'live2d', move, notice,
      view: () => ({ ...local.view(), kind: 'live2d', live2d, cue }),
    };
  }
  return mockAvatar({ idol, voice, status, lookDir });
}

function mockAvatar({ idol, voice, status, lookDir }) {
  let stage = 0, priv = false;
  status?.('avatar', true);
  return {
    kind: 'mock',
    async open() {}, async close() {},
    async offStage(on) { priv = on; return false; },
    view: () => ({ kind: 'image', src: lookSrc(idol, stage, lookDir, priv ? 'off' : undefined), stage }),
    changesLook: () => false,
    async setStage(s) { stage = s; return false; },
    async perform({ text, face, id, tone, withVoice = true }) {
      const audio = voice && withVoice ? await voice.say(text, face, id, tone) : null;
      // Without a voice the page types the line out; keep her on it about as long as reading takes.
      return { audio: audio?.url || null, durationMs: audio?.durationMs || Math.max(3500, text.length * 180) };
    },
  };
}

const PCM_BYTES_PER_MS = 48;          // 24 kHz × 16-bit × mono
const FRAME_MS = 100;                 // docs suggest 20 ms or 100 ms frames
// 按句可停 (stop at a pause): a comment landing while she is musing to herself makes her stop at the next pause in her voice (a
// 100 ms frame this quiet is the gap between sentences or after a comma), never mid-word, and never before she has
// said something. perform({ cut }) asks cut() once per frame.
const QUIET = 500, CUT_MIN_MS = 1200;
const hushed = b => { let sum = 0, n = 0; for (let i = 0; i + 1 < b.length; i += 8) { sum += Math.abs(b.readInt16LE(i)); n++; } return !n || sum / n < QUIET; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function viduAvatar({ idol, voice, status, env, room, lookDir, quiet }) {
  const base = env.VIDU_BASE || 'https://api.vidu.cn/live/v1';
  const key = env.VIDU_KEY;
  const model = env.VIDU_MODEL || 'vidu-s2';
  const actionLib = env.VIDU_ACTION_LIB || idol.avatar.viduActionLib || '';
  let live = null, ws = null, seq = 0, rtc = null, ready = false, stage = 0, wearing = null, backstage = false, opening = null, priv = false;
  const lookKey = () => priv ? 'off' : undefined;   // the look she is in: her stage's, or the off-stage one
  const say = (type, payload) => { if (ws?.readyState !== 1) return false; ws.send(JSON.stringify({ type, live_id: live.id, conn_id: live.conn, seq_id: ++seq, payload })); return true; };
  const msg = content => ({ text_msg: { msg_id: 'm' + seq, content, timestamp: Date.now() } });
  if (!key) status?.('avatar', false, 'VIDU_KEY missing');
  // Between lines a real host doesn't freeze: after a quiet spell she sips her drink, glances at her phone, fixes her
  // hair (idol.fidget). Never while speaking, and an action gets ~10 s before the next (otherwise one covers the next).
  const fid = idol.fidget;
  let speaking = false, lastEnd = Date.now(), lastAct = 0, lastFid = null, fidT = null;
  const gap = () => fid.afterMs[0] + Math.random() * (fid.afterMs[1] - fid.afterMs[0]);
  let nextGap = fid ? gap() : 0;
  // AV_TIMING=1 logs when each move and each line goes out, to line up against a recording of the feed .
  const timing = env.AV_TIMING === '1' ? (...a) => console.log('av', Date.now(), ...a) : () => {};
  let lastBig = true;   // a big move holds the picture ~10 s; a 微表情 is over in a second or two
  const act = name => { if (say(9, msg(actionLib ? name : idol.actions[name].vidu))) { lastAct = Date.now(); lastBig = !idol.actions[name]?.micro; timing('act', name); } };
  // A second small face partway through a long line: a real face keeps moving while
  // it talks. Only a 微表情 (eyes, brows, mouth), only once, about halfway in and never within 4 s of the line's own move.
  const beatAt = (text, beat) => {
    const est = plainText(text).length * 190;
    // from 3.5 s, so most lines get a second face
    return beat && idol.actions[beat]?.micro && est >= 3500 ? Math.max(2500, est / 2) : Infinity;
  };
  const beatNow = (bt, sentMs) => { if (sentMs >= bt.at && Date.now() - lastAct > 2500) { act(bt.beat); return true; } return false; };
  function fidget() {
    const now = Date.now();
    if (!ready || speaking || backstage || now - lastEnd < nextGap || now - lastAct < (lastBig ? 10e3 : 5e3)) return;
    const lonely = fid.lonely && quiet() > (fid.lonelyMs ?? 90e3);
    const pool = (lonely ? fid.lonely : fid.moves).filter(m => m !== lastFid && idol.actions[m]);
    lastFid = pool[Math.floor(Math.random() * pool.length)];
    act(lastFid);
    lastEnd = now; nextGap = gap();
  }

  async function api(path, body, timeoutMs = 120000) {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`vidu ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
    return j;
  }

  function open() {
    if (live || !key) return Promise.resolve();
    opening ||= connect().finally(() => { opening = null; });
    return opening;
  }
  async function connect() {
    const image = env.VIDU_IMAGE || idol.avatar.imageUrl || idol.avatar.image;   // Vidu needs a public URL or a data: URL
    // A pre-uploaded avatar asset (POST /avatars, status success) starts much faster than a raw image (docs: image-upload);
    // each stage has its own (lookAvatar), so she goes on air already dressed for the current stage.
    const avatarId = lookAvatar(idol, stage, env, lookKey());
    const body = { model, ...(avatarId ? { avatar_id: avatarId } : { image_uri: image }), action: actionLib ? { enabled: true, library_id: actionLib } : { enabled: false } };
    // customer_rtc = our own Volcano room (server/rtc.mjs): every visitor gets a ticket. managed_rtc hands out one
    // client token, which only the relay can use.
    if (room) body.customer_rtc = room.publisher();
    else body.managed_rtc = { provider: env.VIDU_RTC_PROVIDER || 'trtc', enable_recording: env.VIDU_RECORD === '1' };
    const r = await api('/external-lives', body);
    wearing = avatarId;
    live = { id: r.live.id, conn: 'lh-' + Date.now(), secret: r.client_secret };
    rtc = r.managed_rtc || null;
    const sock = ws = new WebSocket(`${base.replace(/^http/, 'ws')}/external-lives/${live.id}/stream?conn_id=${live.conn}&client_secret=${encodeURIComponent(live.secret)}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = ev => {
      const m = typeof ev.data === 'string' ? JSON.parse(ev.data) : null;
      if (env.VIDU_DEBUG) console.log('vidu <-', typeof ev.data === 'string' ? ev.data.slice(0, 300) : `binary ${ev.data.byteLength}`);
      if (m?.type === 2) {
        const ack = m.payload?.conn_init_ack;
        if (ack?.success) { ready = true; status?.('avatar', true); if (fid && !fidT) { fidT = setInterval(fidget, 1000); fidT.unref?.(); } }
        else if (ack?.error_code === 'NOT_READY') setTimeout(() => say(1, { conn_init: { version: 1 } }), 2500);   // retry, don't reconnect
        else status?.('avatar', false, `conn_init ${ack?.error_code} ${ack?.error_msg || ''}`);
      }
      if (m?.type === 6) { status?.('avatar', false, 'force_hangup ' + (m.payload?.hangup?.hangup_reason || '')); reset(); }
    };
    // Only this session's socket may end the session: after a backstage change the old one closes late.
    ws.onclose = () => { if (ws === sock && live) { status?.('avatar', false, 'stream closed'); reset(); } };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('vidu ws failed')); });
    say(1, { conn_init: { version: 1 } });
    for (let i = 0; i < 40 && !ready; i++) await sleep(500);
    if (!ready) throw new Error('vidu not ready after 20 s');
  }
  function reset() { clearInterval(fidT); fidT = null; ready = false; live = null; rtc = null; try { ws?.close(); } catch {} ws = null; }
  async function close() {
    if (!live) return;
    say(5, { hangup: { hangup_reason: 'client_hangup' } });
    await sleep(300);
    reset();
  }

  // A new stage on air = she goes backstage to change: the page shows the curtain while this session ends and a new
  // one opens on the new stage's avatar (about 5–10 s). Image swaps inside one session (type 11) blended outfits and
  // drifted her hair, so the look only ever changes with a fresh session.
  const changesLook = s => !!live && lookAvatar(idol, s, env, lookKey()) !== wearing;
  async function setStage(s) {
    stage = s;
    if (!changesLook(s)) return false;
    backstage = true;
    try { await close(); await open(); } finally { backstage = false; }
    return true;
  }

  // 忘关麦: she "forgets" the mic after saying goodbye. A new session on the off-stage picture (the page shows that still
  // while it connects, no curtain: the camera just caught her at home). Off again = back to the stage look next time.
  async function offStage(on) {
    priv = on;
    if (!live || lookAvatar(idol, stage, env, lookKey()) === wearing) return false;
    await close(); await open();
    return true;
  }

  // A real person's face reacts before the words come: the move goes out first, the voice is made at the
  // same time and starts reactLeadMs after the move, or as soon as it is ready if that takes longer.
  // A voice that streams (Doubao pcmStream) starts on its first chunk instead of the whole line (~0.4 s vs up
  // to 2.4 s for a long line); fal still makes the whole line first. AV_TIMING marks: synth (request out), audio
  // (first audio in), line, frame (first frame out), each with ms since the line was asked.
  async function perform({ text, action, beat, id, tone, cut }) {
    if (!ready) throw new Error('vidu not on air');
    if (blurting) await blurting;   // a 先垫一声 still going out finishes first
    speaking = true;
    try {
      const asked = Date.now(), since = () => Date.now() - asked;
      const reacted = Date.now() - blurtAt < 5e3;   // the 先垫一声 already showed her reaction: answer as soon as the voice is ready
      const lead = () => { const wait = asked + (action && !reacted ? idol.avatar.reactLeadMs ?? 0 : 0) - Date.now(); return wait > 0 ? sleep(wait) : null; };
      if (action && idol.actions[action] && Date.now() - blurtAt > 2500) act(action);   // not on top of the reaction still playing
      if (voice) timing('synth', since());
      const bt = { at: beatAt(text, beat), beat };
      if (voice?.pcmStream) return await streamLine(text, voice.pcmStream(text, id, tone)[Symbol.asyncIterator](), since, lead, cut, bt);
      const pcm = voice ? await voice.pcm(text, id, tone) : null;
      if (pcm) timing('audio', since());
      await lead();
      timing('line', pcm ? pcm.length / PCM_BYTES_PER_MS : 0, plainText(text).slice(0, 24));
      say(10, msg(plainText(text)));
      if (!pcm) return { audio: null, durationMs: Math.max(3500, text.length * 180) };
      // Real-time pacing: one 100 ms frame every 100 ms so Vidu's buffer never runs ahead of the mouth.
      const frame = PCM_BYTES_PER_MS * FRAME_MS, t0 = Date.now();
      let beatDone = false;
      for (let off = 0, n = 0; off < pcm.length && ready; off += frame, n++) {
        if (!beatDone && off < pcm.length - 1500 * PCM_BYTES_PER_MS) beatDone = beatNow(bt, off / PCM_BYTES_PER_MS);
        if (cut && off >= CUT_MIN_MS * PCM_BYTES_PER_MS && hushed(pcm.subarray(off, off + frame)) && cut()) {
          timing('cut', Math.round(off / PCM_BYTES_PER_MS));
          return { audio: null, durationMs: 0, spokenMs: Math.round(off / PCM_BYTES_PER_MS), cut: true };
        }
        ws.send(pcm.subarray(off, off + frame));
        if (!n) timing('frame', since());
        const due = t0 + (n + 1) * FRAME_MS - Date.now();
        if (due > 0) await sleep(due);
      }
      return { audio: null, durationMs: 0 };   // already waited out the audio while streaming it
    } finally { speaking = false; lastEnd = Date.now(); }
  }
  // 先垫一声 (filler.mjs): a short ready-made sound the instant a comment lands, while the answer is still
  // being written. Only when she is free; the answer's perform waits for it to finish.
  let blurting = null, blurtAt = 0;
  function blurt(pcm, text, action) {
    if (!ready || speaking || backstage || blurting || !pcm?.length) return false;
    speaking = true; blurtAt = Date.now();
    if (action && idol.actions[action]) act(action);
    blurting = (async () => {
      try {
        timing('blurt', text);
        say(10, msg(text));
        const frame = PCM_BYTES_PER_MS * FRAME_MS, t0 = Date.now();
        for (let off = 0, n = 0; off < pcm.length && ready; off += frame, n++) {
          ws.send(pcm.subarray(off, off + frame));
          const due = t0 + (n + 1) * FRAME_MS - Date.now();
          if (due > 0) await sleep(due);
        }
      } catch {} finally { speaking = false; blurting = null; lastEnd = Date.now(); }
    })();
    return true;
  }

  // The streamed line: chunks keep arriving while frames go out at real-time pace. Only whole 100 ms frames go out
  // (the last may be shorter, never an odd byte: s16le samples are 2 bytes); when the voice falls behind she waits
  // for it and the pacing picks up from then, rather than bursting the backlog at Vidu. Midway failure = the line
  // ends where the audio did. durationMs stays 0 (the audio is waited out here); spokenMs is what actually went out.
  async function streamLine(text, it, since, lead, cut, bt = { at: Infinity }) {
    const first = await it.next().catch(() => ({ done: true }));
    if (!first.done) timing('audio', since());
    let buf = first.done ? Buffer.alloc(0) : first.value, done = !!first.done, stopped = false, wake = null;
    const pump = async () => {
      try {
        for (;;) {
          const r = await it.next();
          if (r.done) break;
          if (stopped) { it.return().catch(() => {}); break; }
          buf = buf.length ? Buffer.concat([buf, r.value]) : r.value;
          wake?.();
        }
      } catch {} finally { done = true; wake?.(); }
    };
    if (!done) pump();
    try {
      await lead();
      timing('line', 'stream', plainText(text).slice(0, 24));
      say(10, msg(plainText(text)));
      if (!buf.length && done) return { audio: null, durationMs: Math.max(3500, text.length * 180) };
      const frame = PCM_BYTES_PER_MS * FRAME_MS;
      let next = 0, sent = 0, wasCut = false, beatDone = false;
      while (ready) {
        if (!beatDone && (buf.length > 1500 * PCM_BYTES_PER_MS || !done)) beatDone = beatNow(bt, sent / PCM_BYTES_PER_MS);
        if (buf.length < frame && !done) { await new Promise(r => { wake = r; }); wake = null; continue; }
        const len = Math.min(frame, buf.length) & ~1;
        if (!len) break;
        if (cut && sent >= CUT_MIN_MS * PCM_BYTES_PER_MS && hushed(buf.subarray(0, len)) && cut()) { wasCut = true; timing('cut', Math.round(sent / PCM_BYTES_PER_MS)); break; }
        if (Date.now() - next > 20) next = Date.now();   // first frame, or the voice fell behind (past timer jitter): pace from now
        ws.send(buf.subarray(0, len));
        if (!sent) timing('frame', since());
        buf = buf.subarray(len); sent += len; next += len / PCM_BYTES_PER_MS;
        if (next > Date.now()) await sleep(next - Date.now());
      }
      timing('spoken', Math.round(sent / PCM_BYTES_PER_MS));
      return { audio: null, durationMs: 0, spokenMs: Math.round(sent / PCM_BYTES_PER_MS), ...(wasCut ? { cut: true } : {}) };
    } finally { stopped = true; }
  }

  return {
    kind: 'vidu', open, close, setStage, changesLook, offStage, perform, blurt,
    // A new comment: she leans in to read it while the answer is being thought up (not mid-line, not over another move).
    notice(name = [].concat(idol.notice ?? [])[Math.floor(Math.random() * [].concat(idol.notice ?? []).length)]) { if (ready && name && idol.actions[name] && !speaking && !backstage && Date.now() - lastAct > 4e3) act(name); },
    // A moment she chose to spend without words (brain: a quiet room, an empty line): just the move.
    move(name) { if (ready && name && idol.actions[name] && !speaking && !backstage) act(name); },
    // Own room: the page asks /api/rtc-ticket for its own ticket. Managed RTC: the one client token, for the relay only.
    view: () => room ? { kind: backstage ? 'backstage' : ready ? 'volc' : 'offline', src: lookSrc(idol, stage, lookDir, lookKey()), app_id: room.appId, room_id: room.roomId, publisher: room.publisherId }
      : ({ kind: backstage ? 'backstage' : ready ? 'rtc' : 'offline', src: lookSrc(idol, stage, lookDir, lookKey()), rtc: ready && rtc ? { provider: rtc.provider, app_id: rtc.app_id, channel_id: rtc.channel_id, user_id: rtc.user_id, token: rtc.token } : null }),
    get onAir() { return ready; },
    get free() { return ready && !speaking && !backstage && !blurting; },   // nothing going out right now
    // Credits left on the account (1 credit = 1 s on air); the balance lives on the general API, not under /live.
    async credits() {
      const r = await fetch(new URL(base).origin + '/ent/v2/credits', { headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      return r.ok ? Number(j.remains?.[0]?.credit_remain ?? NaN) : null;
    },
    get liveId() { return live?.id || null; },
    api,
  };
}
