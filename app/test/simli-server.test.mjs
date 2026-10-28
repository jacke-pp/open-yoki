import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createSimliService, isLocalSimliRequest, simliPublicConfig } from '../server/simli.mjs';
import { createAvatar } from '../server/avatar.mjs';
import { start } from '../server/index.mjs';
import idol from '../idols/example/config.mjs';

const env = { SIMLI_API_KEY: 'private-simli-test-key', SIMLI_FACE_ID: 'private-test-face' };
const response = token => ({ ok: true, json: async () => ({ session_token: token }) });
const statusIs = code => error => error.status === code;

test('Simli configuration is bounded and public metadata contains no credentials', () => {
  assert.deepEqual(simliPublicConfig(), { configured: false, maxSessionLength: 120 });
  assert.deepEqual(simliPublicConfig(env), { configured: true, maxSessionLength: 120 });
  for (const value of ['59', '3601', '90.5', 'no']) assert.throws(() => createSimliService({ env: { ...env, SIMLI_MAX_SESSION_LENGTH: value } }), /SIMLI_MAX_SESSION_LENGTH/);
  assert.throws(() => createSimliService({ env: { ...env, SIMLI_MAX_IDLE_TIME: '121' } }), /SIMLI_MAX_IDLE_TIME/);
  const service = createSimliService({ env: { ...env, SIMLI_MAX_SESSION_LENGTH: '60' } });
  assert.equal(service.health().maxIdleTime, 60);
  assert.equal(service.health().maxSessionLength, 60);
});

test('unconfigured Simli never requests a token', async () => {
  let calls = 0;
  for (const settings of [{}, { SIMLI_API_KEY: env.SIMLI_API_KEY }, { SIMLI_FACE_ID: env.SIMLI_FACE_ID }]) {
    const service = createSimliService({ env: settings, fetchImpl: async () => { calls++; } });
    await assert.rejects(service.create(), statusIs(503));
    assert.equal(service.health().active, false);
    assert.equal(service.health().configured, false);
  }
  assert.equal(calls, 0);
});

test('Simli token requests use server credentials and the PCM16 v2 contract', async () => {
  let request;
  const service = createSimliService({ env, now: () => 1000, fetchImpl: async (url, options) => { request = { url, ...options }; return response('short-lived-token'); } });
  const session = await service.create();
  assert.equal(request.url, 'https://api.simli.ai/compose/token');
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers['x-simli-api-key'], env.SIMLI_API_KEY);
  assert.deepEqual(JSON.parse(request.body), { faceId: env.SIMLI_FACE_ID, apiVersion: 'v2', handleSilence: true, maxSessionLength: 120, maxIdleTime: 60, audioInputFormat: 'pcm16' });
  assert.equal(session.sessionToken, 'short-lived-token');
  assert.equal(session.maxSessionLength, 120);
  assert.equal(session.expiresAt, 121000);
  assert.match(session.leaseId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(Object.keys(session).sort(), ['expiresAt', 'leaseId', 'maxSessionLength', 'sessionToken']);
  assert.equal(JSON.stringify(service.health()).includes('short-lived-token'), false);
  assert.equal(JSON.stringify(service.health()).includes(env.SIMLI_API_KEY), false);
});

test('one pending or active Simli lease prevents a second paid session', async () => {
  let finish, calls = 0;
  const service = createSimliService({ env, fetchImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const first = service.create();
  assert.equal(service.health().active, true);
  await assert.rejects(service.create(), statusIs(409));
  finish(response('session-token'));
  const session = await first;
  await assert.rejects(service.create(), statusIs(409));
  assert.equal(calls, 1);
  assert.throws(() => service.release('00000000-0000-0000-0000-000000000000'), statusIs(409));
  assert.equal(service.health().active, true);
  assert.deepEqual(service.release(session.leaseId), { ok: true });
  assert.equal(service.health().active, false);
  assert.deepEqual(service.release(session.leaseId), { ok: true }, 'cleanup can be repeated');
});

test('expired Simli leases allow a new bounded trial', async () => {
  let at = 0;
  const service = createSimliService({ env, now: () => at, fetchImpl: async () => response('token') });
  const first = await service.create();
  at = first.expiresAt;
  assert.equal(service.health().active, false);
  const second = await service.create();
  assert.notEqual(first.leaseId, second.leaseId);
  assert.equal(second.expiresAt, at + 120000);
});

test('Simli limits repeated trials even after each lease is released', async () => {
  let at = 0, calls = 0;
  const service = createSimliService({ env, now: () => at, fetchImpl: async () => { calls++; return response('token'); } });
  const first = await service.create();
  service.release(first.leaseId);
  await assert.rejects(service.create(), statusIs(429));
  for (let i = 0; i < 2; i++) { at += 3000; service.release((await service.create()).leaseId); }
  at += 3000;
  await assert.rejects(service.create(), statusIs(429));
  assert.equal(calls, 3);
  at = 60000;
  await service.create();
  assert.equal(calls, 4);
});

test('Simli failures clear their lease and never expose upstream error details', async () => {
  let at = 0, calls = 0;
  const service = createSimliService({ env, now: () => at, fetchImpl: async () => {
    calls++;
    if (calls === 1) throw new Error(`upstream leaked ${env.SIMLI_API_KEY}`);
    if (calls === 2) return { ok: false, status: 401, json: async () => { throw new Error('response body must not be read'); } };
    if (calls === 3) return { ok: true, json: async () => ({ session_token: '' }) };
    return response('good-token');
  } });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(service.create(), error => error.status === 502 && !error.message.includes(env.SIMLI_API_KEY));
    assert.equal(service.health().active, false);
    at += 3000;
  }
  at = 60000;
  assert.equal((await service.create()).sessionToken, 'good-token');
});

test('Simli timeouts cancel upstream work and release the pending lease', async () => {
  let requestSignal;
  const service = createSimliService({ env, timeoutMs: 20, fetchImpl: (_url, options) => {
    requestSignal = options.signal;
    return new Promise(() => {}); // Exercise cleanup even if an injected transport ignores abort.
  } });
  await assert.rejects(service.create(), statusIs(504));
  assert.equal(requestSignal.aborted, true);
  assert.equal(service.health().active, false);
});

test('operator cancellation and shutdown cancel pending Simli requests', async () => {
  let signal, calls = 0;
  const service = createSimliService({ env, fetchImpl: (_url, options) => { calls++; signal = options.signal; return new Promise(() => {}); } });
  const already = new AbortController(); already.abort();
  await assert.rejects(service.create({ signal: already.signal }), statusIs(499));
  assert.equal(calls, 0);
  const controller = new AbortController(), pending = service.create({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, statusIs(499));
  assert.equal(signal.aborted, true);
  assert.equal(service.health().active, false);
  const closingService = createSimliService({ env, fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  const closing = closingService.create();
  closingService.close();
  await assert.rejects(closing, statusIs(499));
  assert.equal(signal.aborted, true);
  assert.equal(closingService.health().active, false);
  await assert.rejects(closingService.create(), statusIs(503));
});

test('only an exact loopback operator origin can issue Simli session requests', () => {
  const req = (headers = {}, socket = {}) => ({ headers: { host: '127.0.0.1:4370', origin: 'http://127.0.0.1:4370', ...headers }, socket: { remoteAddress: '127.0.0.1', localPort: 4370, ...socket } });
  assert.equal(isLocalSimliRequest(req()), true);
  assert.equal(isLocalSimliRequest(req({ host: 'localhost:4370', origin: 'http://localhost:4370' })), true);
  assert.equal(isLocalSimliRequest(req({ host: '[::1]:4370', origin: 'http://[::1]:4370' }, { remoteAddress: '::1' })), true);
  const privateAddress = '192.168.' + '1.2', publicAddress = '203.0.' + '113.2';
  for (const address of [privateAddress, publicAddress, '::ffff:' + privateAddress]) assert.equal(isLocalSimliRequest(req({}, { remoteAddress: address })), false);
  for (const headers of [
    { origin: undefined }, { origin: 'null' }, { origin: 'https://127.0.0.1:4370' }, { origin: 'http://127.0.0.1:4371' },
    { origin: 'http://localhost:4370' }, { origin: 'http://127.0.0.1:4370/' }, { host: 'evil.example:4370', origin: 'http://evil.example:4370' },
    { host: '127.0.0.1:4371', origin: 'http://127.0.0.1:4371' }, { host: 'user@127.0.0.1:4370' },
    { 'x-real-ip': '' }, { 'x-forwarded-for': '127.0.0.1' }, { forwarded: 'for=127.0.0.1' }, { 'x-forwarded-host': 'localhost' },
  ]) assert.equal(isLocalSimliRequest(req(headers)), false, JSON.stringify(headers));
  assert.equal(isLocalSimliRequest(req({ origin: undefined }), { requireOrigin: false }), true, 'local read-only health does not require a browser Origin header');
});

test('Simli avatar snapshots reveal only safe configuration and reuse local TTS', async () => {
  const calls = [], avatar = createAvatar({ idol, kind: 'simli', env, voice: { say: async (...args) => { calls.push(args); return { url: '/audio/ready.mp3', durationMs: 42 }; } } });
  const view = avatar.view();
  assert.equal(avatar.kind, 'simli');
  assert.equal(view.kind, 'simli');
  assert.deepEqual(view.simli, { configured: true, maxSessionLength: 120 });
  assert.equal(JSON.stringify(view).includes(env.SIMLI_API_KEY), false);
  assert.equal(JSON.stringify(view).includes(env.SIMLI_FACE_ID), false);
  assert.deepEqual(await avatar.perform({ text: 'hello', face: 'happy', id: 'line1', tone: 'soft' }), { audio: '/audio/ready.mp3', durationMs: 42 });
  assert.equal(calls.length, 1);
});

test('HTTP Simli trials enforce operator-only access and publish audio with the first line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-simli-'));
  const app = await start({ IDOL: 'example', DATA_DIR: dir, MODE: 'test', ON_AIR: 'off', AVATAR: 'simli',
    SIMLI_API_KEY: env.SIMLI_API_KEY, MODEL_OFF: '1', VOICE_OFF: '1', NEWS_OFF: '1', MARKET_OFF: '1' });
  const published = [], originalSay = app.world.say;
  app.world.say = line => { published.push(structuredClone(line)); return originalSay(line); };
  app.avatar.perform = async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { audio: '/audio/simli-ready.mp3', durationMs: 1 }; };
  try {
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const headers = { Origin: base, 'Content-Type': 'application/json' };
    const stateText = await fetch(base + '/api/state').then(r => r.text());
    assert.equal(stateText.includes(env.SIMLI_API_KEY), false);
    assert.deepEqual(JSON.parse(stateText).avatar.simli, { configured: false, maxSessionLength: 120 });
    const health = await fetch(base + '/api/health').then(r => r.json());
    assert.deepEqual(health.simli.missing, ['SIMLI_FACE_ID']);
    for (const hostile of [{ Origin: 'https://evil.example' }, { 'X-Real-IP': '127.0.0.1' }, { 'X-Forwarded-For': '127.0.0.1' }, { Forwarded: 'for=127.0.0.1' }]) {
      const r = await fetch(base + '/api/simli/session', { method: 'POST', headers: { ...headers, ...hostile }, body: '{}' });
      assert.equal(r.status, 403, JSON.stringify(hostile));
    }
    const spoofedHost = await new Promise((resolve, reject) => {
      const request = httpRequest(base + '/api/simli/session', { method: 'POST', headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
      request.once('error', reject); request.end('{}');
    });
    assert.equal(spoofedHost, 403);
    assert.equal((await fetch(base + '/api/simli/session', { method: 'POST', body: '{}' })).status, 403);
    const get = await fetch(base + '/api/simli/session', { headers });
    assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'POST, DELETE');
    assert.equal((await fetch(base + '/api/simli/session', { method: 'POST', headers: { Origin: base }, body: '{}' })).status, 415);
    assert.equal((await fetch(base + '/api/simli/session', { method: 'POST', headers, body: 'null' })).status, 400);
    const unavailable = await fetch(base + '/api/simli/session', { method: 'POST', headers, body: '{}' });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.text()).includes(env.SIMLI_API_KEY), false);
    assert.equal((await fetch(base + '/api/simli/session', { method: 'DELETE', headers, body: '{}' })).status, 400);

    app.schedule.force('on');
    app.brain.add({ kind: 'chat', name: 'Guest', text: 'hello', addr: 'guest-simli', chatId: 'simli-chat' });
    const deadline = Date.now() + 3000;
    while (!published.some(line => line.kind === 'chat') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const line = published.find(line => line.kind === 'chat');
    assert.ok(line, 'chat response was published');
    assert.equal(line.audio, '/audio/simli-ready.mp3', 'audio arrives with the first line publication');
    assert.equal(line.durationMs, 1);
    assert.equal(line.replyTo, 'simli-chat');
  } finally { await app.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});
