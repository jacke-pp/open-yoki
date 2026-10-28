// A manually started, bounded local Simli preview. Room snapshots never allocate a session.
const SAMPLE_RATE = 16000;
const CHUNK_BYTES = 6000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_LINE_SECONDS = 30;
const MAX_PENDING_LINES = 3;

export function isLocalOperator(hostname) {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(String(hostname).toLowerCase());
}

export function pcm16Bytes(samples) {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const sample = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
    view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

export async function decodePCM16(encoded, {
  AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext,
  OfflineAudioContext = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext,
} = {}) {
  if (!AudioContext || !OfflineAudioContext) throw new Error('Audio decoding is unavailable');
  if (!encoded.byteLength || encoded.byteLength > MAX_AUDIO_BYTES) throw new Error('Audio file is too large');
  const decoder = new AudioContext();
  try {
    const decoded = await decoder.decodeAudioData(encoded.slice(0));
    if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > MAX_LINE_SECONDS) {
      throw new Error('Audio must be at most 30 seconds');
    }
    const renderer = new OfflineAudioContext(1, Math.ceil(decoded.duration * SAMPLE_RATE), SAMPLE_RATE);
    const source = renderer.createBufferSource();
    source.buffer = decoded;
    source.connect(renderer.destination);
    source.start();
    const mono = await renderer.startRendering();
    return pcm16Bytes(mono.getChannelData(0));
  } finally {
    await decoder.close().catch(() => {});
  }
}

async function readAudio(response) {
  if (!response.ok) throw new Error('Audio is unavailable');
  if (Number(response.headers?.get('content-length')) > MAX_AUDIO_BYTES) throw new Error('Audio file is too large');
  if (!response.body?.getReader) {
    const result = await response.arrayBuffer();
    if (result.byteLength > MAX_AUDIO_BYTES) throw new Error('Audio file is too large');
    return result;
  }
  const reader = response.body.getReader(), pieces = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_AUDIO_BYTES) throw new Error('Audio file is too large');
      pieces.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
  return bytes.buffer;
}

const SDK = () => import('/vendor/simli/client.js');
const bounded = (promise, ms, setTimer, clearTimer, message) => new Promise((resolve, reject) => {
  const timer = setTimer(() => reject(new Error(message)), ms);
  Promise.resolve(promise).then(resolve, reject).finally(() => clearTimer(timer));
});

export function createSimliView({ video, audio, onState = () => {},
  fetch: request = globalThis.fetch?.bind(globalThis), loadClient = SDK, decode = decodePCM16,
  location = globalThis.location, document = globalThis.document, window = globalThis.window,
  now = Date.now, setTimeout: setTimer = globalThis.setTimeout, clearTimeout: clearTimer = globalThis.clearTimeout,
  startupTimeoutMs = 25000, stopTimeoutMs = 3000,
} = {}) {
  let view = null, onAir = false, destroyed = false, sound = false, generation = 0;
  let session = null, closing = Promise.resolve(), state = 'idle';
  const seen = new Set();
  const local = isLocalOperator(location?.hostname);
  const eligible = () => !destroyed && local && view?.kind === 'simli' && !!view.simli?.configured && onAir && !document?.hidden;
  const current = mine => session === mine && !mine.closed && mine.generation === generation;
  function publish(next, error = null) {
    state = next;
    video.hidden = next !== 'connected';
    audio.muted = !sound;
    onState({ state, ready: next === 'connected', local, available: eligible(), error });
  }
  function remember(id) {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 256) seen.delete(seen.values().next().value);
    return true;
  }
  async function release(mine) {
    if (!mine.leaseId || mine.released) return;
    mine.released = true;
    try {
      await request('/api/simli/session', { method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leaseId: mine.leaseId }), keepalive: true });
    } catch { /* The server lease also expires independently if the browser has gone away. */ }
  }
  function stopSession(mine) {
    if (mine.cleanup) return mine.cleanup;
    mine.closed = true;
    clearTimer(mine.timer); clearTimer(mine.sendTimer);
    mine.audioAbort?.abort(); mine.queue.length = 0;
    try { mine.client?.ClearBuffer(); } catch {}
    mine.wake?.();
    mine.cleanup = (async () => {
      // Keep the acquisition response: losing it could leave a charged session without its lease ID.
      await mine.acquired?.catch(() => {});
      try {
        if (mine.client) await bounded(mine.client.stop(), stopTimeoutMs, setTimer, clearTimer, 'Stop timed out');
      } catch { /* Always release the local lease, including a broken SDK transport. */ }
      finally {
        await release(mine);
        if (!session || session === mine) {
          video.pause?.(); audio.pause?.();
          video.srcObject = null; audio.srcObject = null;
        }
      }
    })();
    return mine.cleanup;
  }
  function disconnect(reason = 'idle', error = null) {
    generation++;
    const mine = session; session = null;
    publish(reason, error);
    if (mine) closing = Promise.allSettled([closing, stopSession(mine)]).then(() => {});
    return closing;
  }
  function fail(mine, error) {
    if (current(mine)) return disconnect('error', error instanceof Error ? error.message : 'Session ended');
  }
  async function connect() {
    if (session || !eligible()) return false;
    const connectingGeneration = ++generation;
    await closing;
    if (connectingGeneration !== generation || !eligible() || session) return false;
    const mine = session = { generation, closed: false, queue: [], audioRevision: 0, ready: false, leaseId: null, client: null };
    publish('connecting');
    try {
      mine.acquired = (async () => {
        const response = await request('/api/simli/session', { method: 'POST', cache: 'no-store',
          headers: { 'content-type': 'application/json' }, body: '{}' });
        if (!response.ok) {
          const failure = await response.json().catch(() => ({}));
          const detail = typeof failure.error === 'string' ? failure.error.slice(0, 160) : 'Session request failed';
          throw new Error(detail + ' (' + response.status + ')');
        }
        const ticket = await response.json();
        mine.leaseId = ticket.leaseId;
        if (!mine.leaseId || !ticket.sessionToken) throw new Error('Session response is invalid');
        return ticket;
      })();
      const ticket = await mine.acquired;
      if (!current(mine)) { await stopSession(mine); return false; }
      const configuredSeconds = Math.min(3600, Math.max(60, Number(view?.simli?.maxSessionLength) || 120));
      const seconds = Math.min(configuredSeconds, Math.max(1, Number(ticket.maxSessionLength) || 120));
      const expires = typeof ticket.expiresAt === 'number' ? ticket.expiresAt : Date.parse(ticket.expiresAt);
      const remaining = Math.max(0, Math.min(seconds * 1000, Number.isFinite(expires) ? expires - now() : Infinity));
      if (!remaining) throw new Error('Session has expired');
      mine.timer = setTimer(() => { if (current(mine)) disconnect('expired'); }, remaining);
      const startupDeadline = now() + startupTimeoutMs;
      const { SimliClient, LogLevel } = await bounded(loadClient(), startupTimeoutMs, setTimer, clearTimer, 'Avatar runtime timed out');
      if (!current(mine)) { await stopSession(mine); return false; }
      audio.muted = !sound;
      mine.client = new SimliClient(ticket.sessionToken, video, audio, null, LogLevel?.INFO);
      for (const name of ['error', 'startup_error']) mine.client.on(name, error => fail(mine, error));
      mine.client.on('stop', () => { if (current(mine)) disconnect('idle'); });
      mine.client.on('speaking', () => { if (current(mine)) mine.speaking = true; });
      mine.client.on('silent', () => { if (current(mine)) mine.speaking = false; });
      // start() resolves with the first frame. Do not allocate any second session on failure.
      mine.client.on('start', () => {});
      await bounded(mine.client.start(), Math.max(1, startupDeadline - now()), setTimer, clearTimer, 'First frame timed out');
      if (!current(mine)) { await stopSession(mine); return false; }
      mine.ready = true; publish('connected');
      return true;
    } catch (error) {
      if (current(mine)) await fail(mine, error);
      else await stopSession(mine);
      return false;
    }
  }
  async function pump(mine) {
    if (mine.processing) return;
    mine.processing = true;
    let revision = mine.audioRevision;
    try {
      while (current(mine) && mine.ready && mine.queue.length) {
        revision = mine.audioRevision;
        const line = mine.queue.shift();
        const controller = mine.audioAbort = new AbortController();
        const response = await request(line.audio, { signal: controller.signal, cache: 'no-store' });
        const encoded = await readAudio(response);
        if (!current(mine)) return;
        if (revision !== mine.audioRevision) continue;
        const pcm = await decode(encoded);
        if (!current(mine)) return;
        if (revision !== mine.audioRevision) continue;
        if (!(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength > SAMPLE_RATE * 2 * MAX_LINE_SECONDS || pcm.byteLength % 2) {
          throw new Error('Audio must be at most 30 seconds');
        }
        // Pace chunks to avoid filling the remote buffer with minutes of stale dialogue.
        for (let offset = 0; offset < pcm.length && current(mine) && revision === mine.audioRevision; offset += CHUNK_BYTES) {
          const chunk = pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length));
          mine.client.sendAudioData(chunk);
          await new Promise(resolve => {
            mine.wake = resolve;
            mine.sendTimer = setTimer(resolve, chunk.byteLength / (SAMPLE_RATE * 2) * 1000);
          });
          mine.wake = null;
        }
      }
    } catch (error) { if (current(mine) && revision === mine.audioRevision) await fail(mine, error); }
    finally {
      mine.processing = false;
      if (current(mine) && mine.ready && mine.queue.length) void pump(mine);
    }
  }
  function interrupt() {
    const mine = session;
    if (!mine || !current(mine)) return;
    mine.audioRevision++;
    mine.queue.length = 0;
    mine.audioAbort?.abort(); clearTimer(mine.sendTimer); mine.wake?.();
    try { mine.client?.ClearBuffer(); } catch (error) { void fail(mine, error); }
  }
  function perform(line, fresh = false) {
    // Remember snapshots even when disconnected, so connecting never replays an old line.
    if (!line || !remember(line.id) || !fresh || !line.audio) return false;
    const mine = session;
    if (!mine?.ready || !current(mine)) return false;
    let source;
    try { source = new URL(line.audio, location?.href); } catch { return false; }
    if (source.origin !== location?.origin || !/^https?:$/.test(source.protocol)) return false;
    if (line.interrupt) interrupt();
    if (mine.queue.length >= MAX_PENDING_LINES) { fail(mine, new Error('Audio queue is full')); return false; }
    mine.queue.push({ audio: source.href });
    void pump(mine);
    return true;
  }
  function setView(next, air = false) {
    const changed = next?.kind !== view?.kind || next?.simli?.configured !== view?.simli?.configured;
    view = next; onAir = !!air;
    if ((changed || !eligible()) && session) void disconnect('idle');
    else if (!session) publish(changed ? 'idle' : state);
  }
  function setSound(on) { sound = !!on; audio.muted = !sound; }
  const hide = () => { if (document?.hidden && session) void disconnect('idle'); else if (!session) publish(state); };
  const leave = () => { if (session) void disconnect('idle'); };
  document?.addEventListener('visibilitychange', hide);
  window?.addEventListener('pagehide', leave);
  async function destroy() {
    destroyed = true;
    document?.removeEventListener('visibilitychange', hide);
    window?.removeEventListener('pagehide', leave);
    await disconnect('idle');
  }
  publish('idle');
  return { connect, disconnect, interrupt, setView, perform, setSound, destroy,
    get ready() { return !!session?.ready && !session.closed; }, get state() { return state; } };
}
