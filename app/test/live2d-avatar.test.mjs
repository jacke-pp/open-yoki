import test from 'node:test';
import assert from 'node:assert/strict';
import { live2dConfig } from '../server/live2d.mjs';
import { createAvatar } from '../server/avatar.mjs';

const idol = {
  notice: ['wave'],
  avatar: { image: '/art/test.jpg', live2d: { model: '/art/host.model3.json',
    expressions: { happy: 'smile' }, motions: { wave: { group: 'TapBody', index: 0 } } } },
  stages: [{ key: 'first' }, { key: 'next' }],
};

test('Live2D keeps the existing voice contract and exposes only the browser model configuration', async () => {
  const spoken = [];
  const avatar = createAvatar({ idol, kind: 'live2d', env: { VIDU_KEY: 'not-for-the-browser' },
    voice: { say: async (...args) => { spoken.push(args); return { url: '/audio/line.mp3', durationMs: 1200 }; } } });
  assert.equal(avatar.kind, 'live2d');
  const line = await avatar.perform({ text: 'hello', face: 'happy', id: 7, tone: 'warm' });
  assert.deepEqual(line, { audio: '/audio/line.mp3', durationMs: 1200 });
  assert.deepEqual(spoken[0], ['hello', 'happy', 7, 'warm']);
  assert.equal(avatar.view().kind, 'live2d');
  assert.equal(avatar.view().live2d.model, '/art/host.model3.json');
  assert.equal(JSON.stringify(avatar.view()).includes('not-for-the-browser'), false);
  await avatar.setStage(1);
  assert.equal(avatar.view().stage, 1);
  avatar.move('wave');
  assert.deepEqual(avatar.view().cue, { id: 1, action: 'wave' });
  avatar.move('unknown');
  assert.equal(avatar.view().cue.id, 1);
  avatar.notice();
  assert.equal(avatar.view().cue.id, 2);
});

test('Live2D without TTS retains text duration and never needs a cloud avatar session', async () => {
  const avatar = createAvatar({ idol, kind: 'live2d' });
  await avatar.open();
  const line = await avatar.perform({ text: 'hello', withVoice: false });
  assert.equal(line.audio, null);
  assert.ok(line.durationMs > 0);
  await avatar.close();
});

test('operators can override the model URL, but remote script/model URLs and malformed maps are rejected', () => {
  assert.equal(live2dConfig(idol, { LIVE2D_MODEL: '/art/another.model3.json?v=2' }).model, '/art/another.model3.json?v=2');
  for (const url of ['https://example.org/host.model3.json', '//example.org/host.model3.json', '/art/host.json', '/art/host.model3.json#part', '/\\evil.model3.json']) {
    assert.throws(() => live2dConfig(idol, { LIVE2D_MODEL: url }), /LIVE2D_MODEL/);
  }
  assert.throws(() => live2dConfig(idol, { LIVE2D_CORE: 'https://example.org/core.js' }), /LIVE2D_CORE/);
  assert.throws(() => live2dConfig({ avatar: {} }), /LIVE2D_MODEL/);
  assert.throws(() => live2dConfig({ avatar: { live2d: { ...idol.avatar.live2d, motions: { wave: { group: 'Idle', index: -1 } } } } }), /motions/);
});
