import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { start } from '../server/index.mjs';

test('a local Live2D line is published with its finished audio, and Codex billing is never shown as free', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-local-providers-'));
  const app = await start({ IDOL: 'example', DATA_DIR: dir, MODE: 'test', ON_AIR: 'off',
    AVATAR: 'live2d', LIVE2D_MODEL: '/art/host.model3.json', MODEL_PROVIDER: 'codex',
    MODEL_OFF: '1', VOICE_OFF: '1', NEWS_OFF: '1', MARKET_OFF: '1' });
  const published = [];
  const say = app.world.say;
  app.world.say = line => { published.push(structuredClone(line)); return say(line); };
  app.avatar.perform = async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { audio: '/audio/finished.mp3', durationMs: 1 };
  };
  try {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const health = await fetch(base + '/api/health').then(r => r.json());
    assert.equal(health.modelProvider, 'codex');
    assert.equal(health.modelSpend.usd, null);
    assert.equal(health.modelSpend.costKnown, false);
    const state = await fetch(base + '/api/state').then(r => r.json());
    assert.equal(state.avatar.kind, 'live2d');
    assert.equal(state.avatar.live2d.model, '/art/host.model3.json');
    assert.equal(health.square, null, 'local rendering does not create the RTC push pipeline');

    app.schedule.force('on');
    app.brain.add({ kind: 'chat', name: 'Guest', text: 'hello', addr: 'guest-local', chatId: 'local-chat' });
    const deadline = Date.now() + 3000;
    while (!published.some(line => line.kind === 'chat') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const line = published.find(line => line.kind === 'chat');
    assert.ok(line, 'a chat reply was published');
    assert.equal(line.audio, '/audio/finished.mp3', 'audio is present on the first publication, before browser line-ID deduplication');
    assert.equal(line.durationMs, 1);
    assert.equal(line.replyTo, 'local-chat');
  } finally {
    await app.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
