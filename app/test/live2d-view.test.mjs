import test from 'node:test';
import assert from 'node:assert/strict';
import { createLive2DView, createMouthMeter, localAsset, prepareModelSettings } from '../public/live2d.js';
import { tarEntries, installLive2D } from '../tools/setup-live2d.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const BASE = 'http://127.0.0.1:4370/';
const view = (model = '/art/host/live2d/host.model3.json', cue = null) => ({ kind: 'live2d', cue, live2d: {
  model, pixi: '/vendor/live2d/pixi.min.js', core: '/vendor/live2d/live2dcubismcore.min.js',
  display: '/vendor/live2d/cubism4.min.js', expressions: { happy: 'smile' }, motions: { wave: { group: 'TapBody', index: 1 } },
} });
const manifest = () => ({ Version: 3, FileReferences: { Moc: 'host.moc3', Textures: ['texture.png'],
  Motions: { TapBody: [{ File: 'wave.motion3.json', Sound: 'stock.wav' }] } } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(factory = async () => makeModel()) {
  const models = [], apps = [], errors = [], ready = [];
  const container = { hidden: false, clientWidth: 400, clientHeight: 600, children: [], replaceChildren(...items) { this.children = items; } };
  const runtime = {
    live2d: { Live2DModel: { async from(settings, options) { const m = await factory(settings, options); models.push(m); return m; } } },
    Application: class {
      constructor() {
        apps.push(this); this.view = {}; this.children = [];
        this.stage = { addChild: m => this.children.push(m) };
        this.renderer = { resize: (w, h) => { this.size = [w, h]; } };
      }
      destroy() { this.destroyed = true; for (const child of this.children) child.destroy(); }
    },
  };
  const meter = { resume: async () => {}, value: () => 0.4, destroy() { this.destroyed = true; } };
  const renderer = createLive2DView({ container, audio: {}, meter, base: BASE,
    loadRuntime: async () => runtime,
    fetchImpl: async () => ({ ok: true, json: async () => manifest() }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn(); } disconnect() {} },
    onError: error => errors.push(error), onReady: value => ready.push(value),
  });
  return { renderer, container, models, apps, errors, ready, meter };
}
function makeModel() {
  const handlers = new Map(), parameters = [], motions = [], expressions = [];
  return { width: 100, height: 200, destroyed: 0, handlers, parameters, motions, expressions,
    anchor: { set() {} }, scale: { set(value) { this.value = value; } }, position: { set() {} },
    internalModel: { on: (name, fn) => handlers.set(name, fn), off: name => handlers.delete(name),
      coreModel: { setParameterValueById: (...args) => parameters.push(args) } },
    motion: async (...args) => motions.push(args), expression: async name => expressions.push(name),
    destroy() { this.destroyed++; },
  };
}

test('model manifests keep assets local and remove stock audio without mutating the source', () => {
  const original = manifest();
  const result = prepareModelSettings(original, BASE + 'art/host/host.model3.json');
  assert.equal(result.url, BASE + 'art/host/host.model3.json');
  assert.equal(result.FileReferences.Motions.TapBody[0].Sound, undefined);
  assert.equal(original.FileReferences.Motions.TapBody[0].Sound, 'stock.wav');
  original.FileReferences.Textures[0] = 'https://remote.invalid/image.png';
  assert.throws(() => prepareModelSettings(original, BASE), /same-origin/);
  assert.throws(() => localAsset('//remote.invalid/script.js', BASE), /root-relative/);
  assert.throws(() => localAsset('/\\remote.invalid/script.js', BASE), /root-relative/);
  assert.equal(localAsset('/vendor/live2d/core.js', BASE), BASE + 'vendor/live2d/core.js');
});

test('one model instance handles snapshots, distinct action cues, expressions, TTS mouth movement, and cleanup', async () => {
  const f = fixture(), v = view(undefined, { id: 1, action: 'wave' });
  assert.equal(await f.renderer.setView(v), true);
  await f.renderer.setView(structuredClone(v));
  assert.equal(f.models.length, 1);
  const model = f.models[0];
  assert.equal(model.motions.length, 1, 'a repeated snapshot must not replay its cue');
  f.renderer.perform({ id: 'line-1', face: 'happy', action: 'wave' });
  f.renderer.perform({ id: 'line-1', face: 'happy', action: 'wave' });
  assert.deepEqual(model.expressions, ['smile']);
  assert.equal(model.motions.length, 2);
  assert.deepEqual(model.motions[1], ['TapBody', 1, 3]);
  model.handlers.get('beforeModelUpdate')();
  assert.deepEqual(model.parameters, [['ParamMouthOpenY', 0.4]]);
  assert.deepEqual(f.apps[0].size, [400, 600]);
  assert.equal(f.container.hidden, false);
  await f.renderer.setView({ kind: 'image' });
  assert.equal(f.container.hidden, true);
  assert.equal(model.destroyed, 1);
  assert.equal(model.handlers.size, 0);
  f.renderer.destroy();
  assert.equal(f.meter.destroyed, true);
});

test('a model resolving after a driver change is disposed and cannot replace the current picture', async () => {
  const gate = deferred(), model = makeModel();
  const f = fixture(() => gate.promise);
  const pending = f.renderer.setView(view());
  await new Promise(resolve => setImmediate(resolve));
  await f.renderer.setView({ kind: 'image' });
  gate.resolve(model);
  assert.equal(await pending, false);
  assert.equal(model.destroyed, 1);
  assert.equal(f.apps.length, 0);
  assert.equal(f.container.hidden, true);
});

test('changing the model while the first load is pending keeps the latest model and disposes the old one', async () => {
  const gate = deferred(), old = makeModel(), latest = makeModel();
  const f = fixture(settings => settings.url.includes('old.model3') ? gate.promise : latest);
  const pending = f.renderer.setView(view('/art/host/old.model3.json'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.renderer.setView(view('/art/host/new.model3.json')), true);
  gate.resolve(old);
  assert.equal(await pending, false);
  assert.equal(old.destroyed, 1);
  assert.equal(latest.destroyed, 0);
  assert.equal(f.renderer.ready, true);
  f.renderer.destroy();
});

test('missing runtime fails to a still picture once, without retrying on every room snapshot', async () => {
  let calls = 0;
  const errors = [], container = { hidden: false, replaceChildren() {} };
  const renderer = createLive2DView({ container, audio: {}, base: BASE,
    meter: { resume() {}, destroy() {} }, loadRuntime: async () => { calls++; throw new Error('not installed'); },
    onError: e => errors.push(e),
  });
  assert.equal(await renderer.setView(view()), false);
  assert.equal(await renderer.setView(view()), false);
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  assert.equal(container.hidden, true);
  renderer.destroy();
});

test('the mouth meter creates one audio graph and closes the mouth on silence, mute, and pause', async () => {
  let created = 0, closed = 0, level = 128;
  const audio = { paused: false, ended: false, muted: false };
  class AudioContext {
    constructor() { created++; this.state = 'suspended'; this.destination = {}; }
    createMediaElementSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { connect() {}, disconnect() {}, getByteTimeDomainData: a => a.fill(level) }; }
    async resume() { this.state = 'running'; }
    async close() { closed++; }
  }
  const meter = createMouthMeter(audio, AudioContext);
  await meter.resume(); await meter.resume();
  assert.equal(created, 1);
  assert.equal(meter.value(), 0);
  level = 132;
  assert.ok(meter.value() > 0 && meter.value() < 1);
  audio.paused = true;
  assert.equal(meter.value(), 0);
  audio.paused = false; audio.muted = true;
  assert.equal(meter.value(), 0);
  meter.destroy();
  assert.equal(closed, 1);
});

test('runtime setup rejects corrupted downloads before writing any browser script', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'live2d-setup-'));
  try {
    const core = path.join(temp, 'core.js');
    await writeFile(core, 'var Live2DCubismCore = {};');
    const dest = path.join(temp, 'runtime');
    await assert.rejects(installLive2D(core, { dest, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('corrupted') }) }), /Integrity check/);
    await assert.rejects(readFile(path.join(dest, 'pixi.min.js')), { code: 'ENOENT' });
    assert.throws(() => tarEntries(Buffer.alloc(512), ['package/runtime.js']), /missing/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
