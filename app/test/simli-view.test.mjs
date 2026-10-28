import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimliView, decodePCM16, pcm16Bytes, isLocalOperator } from '../public/simli.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const view = () => ({ kind: 'simli', simli: { configured: true, maxSessionLength: 120 } });
const location = { hostname: '127.0.0.1', origin: 'http://127.0.0.1:4370', href: 'http://127.0.0.1:4370/' };
function target() {
  const events = new Map();
  return { hidden: false, addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name), emit: name => events.get(name)?.(), events };
}
function clock() {
  let now = 1000, next = 0;
  const timers = new Map();
  return { now: () => now, setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id), timers,
    tick(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } } };
}
function fixture(options = {}) {
  const calls = [], clients = [], states = [], document = target(), window = target(), time = clock();
  const video = { hidden: true, srcObject: 'video', pause() { this.paused = true; } };
  const audio = { muted: false, srcObject: 'audio', pause() { this.paused = true; } };
  class Client {
    constructor(...args) { this.args = args; this.events = new Map(); this.sent = []; this.cleared = 0; this.stops = 0; clients.push(this); }
    on(name, fn) { this.events.set(name, fn); }
    emit(name, error) { this.events.get(name)?.(error); }
    start() { return options.start ? options.start(this) : Promise.resolve(); }
    stop() { this.stops++; calls.push({ stop: true }); this.emit('stop'); return options.stop ? options.stop() : Promise.resolve(); }
    sendAudioData(bytes) { this.sent.push(new Uint8Array(bytes)); }
    ClearBuffer() { this.cleared++; }
  }
  const request = async (url, init = {}) => {
    calls.push({ url, ...init });
    if (options.fetch) return options.fetch(url, init, calls);
    if (init.method === 'POST') return { ok: true, json: async () => ({ leaseId: 'lease-' + calls.length,
      sessionToken: 'token-' + calls.length, maxSessionLength: 120, expiresAt: time.now() + 120000 }) };
    if (init.method === 'DELETE') return { ok: true };
    return { ok: true, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  const renderer = createSimliView({ video, audio, location, document, window, fetch: request,
    loadClient: options.loadClient || (async () => ({ SimliClient: Client, LogLevel: { INFO: 1 } })),
    decode: options.decode || (async () => new Uint8Array(6000)), onState: state => states.push(state),
    ...time, ...options.renderer });
  renderer.setView(view(), true);
  return { renderer, clients, calls, states, document, window, time, video, audio };
}

test('only an explicit local connect allocates a paid session', async t => {
  const f = fixture(); t.after(() => f.renderer.destroy());
  f.renderer.setView(view(), true);
  f.renderer.perform({ id: 1, audio: '/voice.wav' }, true);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.renderer.connect(), true);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.clients.length, 1);
  assert.equal(f.clients[0].args[0], 'token-1');
  assert.equal(f.clients[0].args[3], null);
  assert.equal(f.video.hidden, false);
  assert.equal(f.audio.muted, true);
  assert.deepEqual([...f.clients[0].events.keys()].sort(), ['error', 'silent', 'speaking', 'start', 'startup_error', 'stop']);
});

test('remote viewers, unconfigured avatars and off-air rooms cannot connect', async t => {
  assert.equal(isLocalOperator('127.0.0.1.evil.test'), false);
  assert.equal(isLocalOperator('[::1]'), true);
  const remote = fixture({ renderer: { location: { ...location, hostname: 'example.com' } } });
  t.after(() => remote.renderer.destroy());
  assert.equal(await remote.renderer.connect(), false);
  assert.equal(remote.calls.length, 0);
  const f = fixture(); t.after(() => f.renderer.destroy());
  f.renderer.setView({ kind: 'simli', simli: { configured: false } }, true);
  assert.equal(await f.renderer.connect(), false);
  f.renderer.setView(view(), false);
  assert.equal(await f.renderer.connect(), false);
  assert.equal(f.calls.length, 0);
});

test('sound only mutes the returned stream and never stops video generation', async t => {
  const f = fixture(); t.after(() => f.renderer.destroy());
  await f.renderer.connect();
  f.renderer.setSound(true); assert.equal(f.audio.muted, false);
  f.renderer.setSound(false); assert.equal(f.audio.muted, true);
  assert.equal(f.clients[0].stops, 0);
  assert.equal(f.renderer.perform({ id: 1, audio: '/voice.wav' }, true), true);
  await flush(); assert.equal(f.clients[0].sent.length, 1);
});

test('old snapshots and duplicate lines are never replayed after connecting', async t => {
  const f = fixture(); t.after(() => f.renderer.destroy());
  const old = { id: 'old', audio: '/voice.wav' };
  assert.equal(f.renderer.perform(old, false), false);
  await f.renderer.connect();
  assert.equal(f.renderer.perform(old, true), false);
  assert.equal(f.renderer.perform({ id: 'fresh', audio: '/voice.wav' }, true), true);
  assert.equal(f.renderer.perform({ id: 'fresh', audio: '/voice.wav' }, true), false);
  await flush(); assert.equal(f.clients[0].sent.length, 1);
});

test('PCM is sent in 6000-byte chunks at audio speed, including the final short chunk', async t => {
  const f = fixture({ decode: async () => new Uint8Array(14000) }); t.after(() => f.renderer.destroy());
  await f.renderer.connect();
  f.renderer.perform({ id: 1, audio: '/voice.wav' }, true);
  await flush(); assert.deepEqual(f.clients[0].sent.map(b => b.length), [6000]);
  f.time.tick(187.5); await flush();
  assert.deepEqual(f.clients[0].sent.map(b => b.length), [6000, 6000]);
  f.time.tick(187.5); await flush();
  assert.deepEqual(f.clients[0].sent.map(b => b.length), [6000, 6000, 2000]);
});

test('external and malformed audio URLs are not fetched', async t => {
  const f = fixture(); t.after(() => f.renderer.destroy()); await f.renderer.connect();
  assert.equal(f.renderer.perform({ id: 1, audio: 'https://other.test/a.wav' }, true), false);
  assert.equal(f.renderer.perform({ id: 2, audio: 'data:audio/wav,a' }, true), false);
  assert.equal(f.calls.length, 1);
});

test('overlong decoded audio disconnects and releases the lease', async t => {
  const f = fixture({ decode: async () => new Uint8Array(960002) }); t.after(() => f.renderer.destroy());
  await f.renderer.connect(); f.renderer.perform({ id: 1, audio: '/voice.wav' }, true); await flush();
  assert.equal(f.renderer.state, 'error');
  assert.equal(f.clients[0].sent.length, 0);
  assert.equal(f.clients[0].stops, 1);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
});

test('an oversized response is rejected before decoding', async t => {
  let decodes = 0;
  const f = fixture({ decode: async () => { decodes++; return new Uint8Array(6000); }, fetch: async (url, init) => {
    if (init.method === 'POST') return { ok: true, json: async () => ({ leaseId: 'lease', sessionToken: 'token', maxSessionLength: 120 }) };
    if (init.method === 'DELETE') return { ok: true };
    return { ok: true, headers: { get: () => String(9 * 1024 * 1024) } };
  } }); t.after(() => f.renderer.destroy());
  await f.renderer.connect(); f.renderer.perform({ id: 1, audio: '/voice.wav' }, true); await flush();
  assert.equal(decodes, 0); assert.equal(f.renderer.state, 'error');
});

test('the pending audio queue is bounded and does not silently drop speech', async t => {
  const decoded = deferred(), f = fixture({ decode: () => decoded.promise }); t.after(() => f.renderer.destroy());
  await f.renderer.connect();
  for (let id = 1; id <= 4; id++) assert.equal(f.renderer.perform({ id, audio: '/voice.wav' }, true), true);
  assert.equal(f.renderer.perform({ id: 5, audio: '/voice.wav' }, true), false);
  await flush(); assert.equal(f.renderer.state, 'error'); assert.equal(f.clients[0].stops, 1);
  decoded.resolve(new Uint8Array(6000)); await flush(); assert.equal(f.clients[0].sent.length, 0);
});

test('interrupt clears SDK buffers, cancels pending audio and permits a fresh line', async t => {
  const f = fixture({ decode: async () => new Uint8Array(14000) }); t.after(() => f.renderer.destroy());
  await f.renderer.connect(); f.renderer.perform({ id: 1, audio: '/voice.wav' }, true); await flush();
  f.renderer.interrupt(); await flush(); f.time.tick(500); await flush();
  assert.equal(f.clients[0].sent.length, 1); assert.equal(f.clients[0].cleared, 1);
  f.renderer.perform({ id: 2, audio: '/voice.wav' }, true); await flush();
  assert.equal(f.clients[0].sent.length, 2);
});

test('late decoding cannot send into a stopped or replaced SDK', async t => {
  const decoded = deferred(), f = fixture({ decode: () => decoded.promise }); t.after(() => f.renderer.destroy());
  await f.renderer.connect(); f.renderer.perform({ id: 1, audio: '/voice.wav' }, true); await flush();
  await f.renderer.disconnect(); await f.renderer.connect();
  decoded.resolve(new Uint8Array(6000)); await flush();
  assert.equal(f.clients.length, 2);
  assert.equal(f.clients[0].sent.length + f.clients[1].sent.length, 0);
});

test('disconnect during token acquisition releases the late lease without constructing the SDK', async t => {
  const response = deferred();
  const f = fixture({ fetch: (url, init) => init.method === 'POST' ? response.promise : Promise.resolve({ ok: true }) });
  t.after(() => f.renderer.destroy());
  const connected = f.renderer.connect(); await flush();
  const stopped = f.renderer.disconnect();
  response.resolve({ ok: true, json: async () => ({ leaseId: 'late', sessionToken: 'secret', maxSessionLength: 120 }) });
  assert.equal(await connected, false); await stopped;
  assert.equal(f.clients.length, 0);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
  assert.deepEqual(JSON.parse(f.calls.find(c => c.method === 'DELETE').body), { leaseId: 'late' });
});

test('disconnect while the SDK module loads cannot construct a stale client', async t => {
  const module = deferred(), f = fixture({ loadClient: () => module.promise }); t.after(() => f.renderer.destroy());
  const connected = f.renderer.connect(); await flush(); await f.renderer.disconnect();
  module.resolve({ SimliClient: class { constructor() { assert.fail('stale SDK'); } } });
  assert.equal(await connected, false);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
});

test('first-frame timeout cleans up and never reconnects automatically', async t => {
  const started = deferred(), f = fixture({ start: () => started.promise }); t.after(() => f.renderer.destroy());
  const connected = f.renderer.connect(); await flush(); f.time.tick(25000); await flush();
  assert.equal(await connected, false); assert.equal(f.renderer.state, 'error');
  assert.equal(f.clients[0].stops, 1); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  started.resolve(); await flush(); assert.equal(f.renderer.ready, false);
});

test('a late first frame cannot restore a disconnected session', async t => {
  const started = deferred(), f = fixture({ start: () => started.promise }); t.after(() => f.renderer.destroy());
  const connected = f.renderer.connect(); await flush();
  await f.renderer.disconnect(); started.resolve();
  assert.equal(await connected, false); assert.equal(f.video.hidden, true);
  assert.equal(f.clients[0].stops, 1);
});

test('simultaneous connect clicks cannot allocate two sessions', async t => {
  const f = fixture(); t.after(() => f.renderer.destroy());
  const results = await Promise.all([f.renderer.connect(), f.renderer.connect()]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('a hanging SDK stop is bounded and still releases its server lease', async () => {
  const stopped = deferred(), f = fixture({ stop: () => stopped.promise }); await f.renderer.connect();
  const disconnect = f.renderer.disconnect(); await flush();
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0);
  f.time.tick(3000); await disconnect;
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
  stopped.resolve(); await f.renderer.destroy();
});

test('SDK failures stop before deleting the lease; a manual reconnect uses a new client', async t => {
  const f = fixture(); t.after(() => f.renderer.destroy()); await f.renderer.connect();
  f.clients[0].emit('startup_error', new Error('upstream failure')); await flush();
  const stopIndex = f.calls.findIndex(c => c.stop), releaseIndex = f.calls.findIndex(c => c.method === 'DELETE');
  assert.ok(stopIndex >= 0 && releaseIndex > stopIndex);
  assert.equal(f.renderer.state, 'error'); assert.equal(f.clients.length, 1);
  await f.renderer.connect(); assert.equal(f.clients.length, 2);
  assert.notEqual(f.clients[0].args[0], f.clients[1].args[0]);
});

test('hiding, leaving, changing avatar and going off air terminate sessions', async () => {
  for (const reason of ['hidden', 'pagehide', 'avatar', 'offair']) {
    const f = fixture(); await f.renderer.connect();
    if (reason === 'hidden') { f.document.hidden = true; f.document.emit('visibilitychange'); }
    if (reason === 'pagehide') f.window.emit('pagehide');
    if (reason === 'avatar') f.renderer.setView({ kind: 'mock' }, true);
    if (reason === 'offair') f.renderer.setView(view(), false);
    await flush(); assert.equal(f.clients[0].stops, 1, reason);
    assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1, reason);
    assert.equal(f.video.srcObject, null); assert.equal(f.audio.srcObject, null);
    await f.renderer.destroy();
    assert.equal(f.document.events.size + f.window.events.size, 0);
  }
});

test('returning to a visible page enables a manual connection without starting it', async t => {
  const f = fixture(); t.after(() => f.renderer.destroy());
  f.document.hidden = true; f.document.emit('visibilitychange');
  assert.equal(f.states.at(-1).available, false);
  f.document.hidden = false; f.document.emit('visibilitychange');
  assert.equal(f.states.at(-1).available, true); assert.equal(f.calls.length, 0);
});

test('a session ticket cannot exceed the configured preview duration', async t => {
  const f = fixture({ fetch: async (url, init) => init.method === 'POST' ? { ok: true, json: async () => ({
    leaseId: 'lease', sessionToken: 'token', maxSessionLength: 3600, expiresAt: 3601000 }) } : { ok: true } });
  t.after(() => f.renderer.destroy()); await f.renderer.connect();
  f.time.tick(119999); await flush(); assert.equal(f.renderer.ready, true);
  f.time.tick(1); await flush(); assert.equal(f.renderer.state, 'expired'); assert.equal(f.renderer.ready, false);
  assert.equal(f.clients[0].stops, 1);
});

test('an explicitly longer configured duration is honored', async t => {
  const f = fixture({ fetch: async (url, init) => init.method === 'POST' ? { ok: true, json: async () => ({
    leaseId: 'lease', sessionToken: 'token', maxSessionLength: 3600, expiresAt: 3601000 }) } : { ok: true } });
  t.after(() => f.renderer.destroy());
  f.renderer.setView({ kind: 'simli', simli: { configured: true, maxSessionLength: 3600 } }, true);
  await f.renderer.connect(); f.time.tick(120000); await flush(); assert.equal(f.renderer.ready, true);
  f.time.tick(3480000); await flush(); assert.equal(f.renderer.state, 'expired');
  assert.equal(f.clients[0].stops, 1);
});

test('an earlier lease expiry is honored', async t => {
  const f = fixture({ fetch: async (url, init) => init.method === 'POST' ? { ok: true, json: async () => ({
    leaseId: 'lease', sessionToken: 'token', maxSessionLength: 120, expiresAt: 6000 }) } : { ok: true } });
  t.after(() => f.renderer.destroy()); await f.renderer.connect(); f.time.tick(5000); await flush();
  assert.equal(f.renderer.state, 'expired');
});

test('destroy is idempotent and no further sessions can be allocated', async () => {
  const f = fixture(); await f.renderer.connect(); await Promise.all([f.renderer.destroy(), f.renderer.destroy()]);
  assert.equal(f.clients[0].stops, 1); assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
  f.renderer.setView(view(), true); assert.equal(await f.renderer.connect(), false);
});

test('PCM samples are clipped, finite, signed 16-bit and little endian', () => {
  const bytes = pcm16Bytes(new Float32Array([-2, -1, 0, 1, 2, NaN]));
  const data = new DataView(bytes.buffer);
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => data.getInt16(i * 2, true)), [-32768, -32768, 0, 32767, 32767, 0]);
});

test('decoded audio is rendered as 16kHz mono and the temporary context is closed', async () => {
  let closed = 0, offline, started = 0;
  class AudioContext {
    async decodeAudioData() { return { duration: .5, numberOfChannels: 2, sampleRate: 48000 }; }
    async close() { closed++; }
  }
  class OfflineAudioContext {
    constructor(...args) { offline = args; this.destination = {}; }
    createBufferSource() { return { connect() {}, start() { started++; } }; }
    async startRendering() { return { getChannelData: () => new Float32Array([-.5, .5]) }; }
  }
  const bytes = await decodePCM16(new ArrayBuffer(16), { AudioContext, OfflineAudioContext });
  assert.deepEqual(offline, [1, 8000, 16000]); assert.equal(closed, 1); assert.equal(started, 1);
  assert.equal(bytes.length, 4);
});

test('decode failures and overlong audio close the temporary context', async () => {
  for (const duration of [NaN, 0, 30.01]) {
    let closed = false;
    class AudioContext { async decodeAudioData() { return { duration }; } async close() { closed = true; } }
    await assert.rejects(decodePCM16(new ArrayBuffer(8), { AudioContext, OfflineAudioContext: class {} }), /30 seconds/);
    assert.equal(closed, true);
  }
});
