// Optional browser renderer. Runtime files and model assets are supplied by the operator, never a CDN at playback.
const scripts = new WeakMap();

export function localAsset(value, base = globalThis.location?.href) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new Error('Live2D assets must use root-relative URLs');
  }
  const url = new URL(value, base);
  if (url.origin !== new URL(base).origin) throw new Error('Live2D assets must be same-origin');
  return url.href;
}

function loadScript(src, ready, document, timeoutMs = 15000) {
  if (ready()) return Promise.resolve();
  let pending = scripts.get(document);
  if (!pending) scripts.set(document, pending = new Map());
  if (pending.has(src)) return pending.get(src);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const finish = error => {
      clearTimeout(timer);
      script.onload = script.onerror = null;
      if (error) { script.remove(); pending.delete(src); reject(error); } else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Live2D runtime load timed out')), timeoutMs);
    script.src = src;
    script.onload = () => finish(ready() ? null : new Error('Live2D runtime did not initialize'));
    script.onerror = () => finish(new Error('Live2D runtime is unavailable'));
    document.head.append(script);
  });
  pending.set(src, promise);
  return promise;
}

export async function loadLive2DRuntime(config, window = globalThis.window) {
  const { document } = window;
  const base = window.location.href;
  await loadScript(localAsset(config.pixi, base), () => window.PIXI, document);
  await loadScript(localAsset(config.core, base), () => window.Live2DCubismCore, document);
  await loadScript(localAsset(config.display, base), () => window.PIXI?.live2d?.Live2DModel, document);
  return window.PIXI;
}

// Model motion files can contain stock voice recordings. TTS is the only audio source in this room.
export function prepareModelSettings(settings, url) {
  const result = structuredClone(settings);
  const references = result.FileReferences;
  if (!references?.Moc || !Array.isArray(references.Textures)) throw new Error('Expected a Cubism model3 manifest');
  const localReference = path => {
    const resolved = new URL(path, url);
    if (resolved.origin !== new URL(url).origin || !/^https?:$/.test(resolved.protocol)) {
      throw new Error('Live2D model references must be same-origin');
    }
  };
  for (const field of ['Moc', 'Physics', 'Pose', 'UserData', 'DisplayInfo']) if (references[field]) localReference(references[field]);
  for (const texture of references.Textures) localReference(texture);
  for (const expression of references.Expressions || []) localReference(expression.File);
  for (const motions of Object.values(references.Motions || {})) for (const motion of motions) {
    delete motion.Sound;
    localReference(motion.File);
  }
  result.url = url;
  return result;
}

// One graph for this audio element for the page's lifetime: MediaElementSource cannot be recreated for one element.
export function createMouthMeter(audio, AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext) {
  let context = null, source = null, analyser = null, samples = null;
  return {
    async resume() {
      if (!AudioContext) return;
      if (!context) {
        context = new AudioContext();
        source = context.createMediaElementSource(audio);
        analyser = context.createAnalyser();
        analyser.fftSize = 256;
        samples = new Uint8Array(analyser.fftSize);
        source.connect(analyser);
        analyser.connect(context.destination);
      }
      if (context.state === 'suspended') await context.resume();
    },
    value() {
      if (!analyser || audio.paused || audio.ended || audio.muted) return 0;
      analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, n) => sum + ((n - 128) / 128) ** 2, 0) / samples.length);
      return Math.min(1, rms * 5);
    },
    destroy() {
      source?.disconnect(); analyser?.disconnect();
      context?.close().catch(() => {});
      context = source = analyser = samples = null;
    },
  };
}

export function createLive2DView({ container, audio, onError = () => {}, onReady = () => {},
  loadRuntime = loadLive2DRuntime, fetchImpl = globalThis.fetch, base = globalThis.location?.href,
  ResizeObserver = globalThis.ResizeObserver, meter = createMouthMeter(audio) }) {
  let generation = 0, key = null, pending = null, config = null, current = null, dead = false;
  let observer = null, lastLine = null, lastCue = null, queuedLine = null, queuedCue = null;
  container.hidden = true;

  function clear() {
    observer?.disconnect(); observer = null;
    if (current) {
      current.model.internalModel.off('beforeModelUpdate', current.updateMouth);
      current.app.destroy(true, { children: true, texture: true, baseTexture: true });
      current = null;
    }
    container.replaceChildren(); container.hidden = true;
  }
  function motion(action) {
    const selected = config?.motions?.[action];
    if (!current || !selected?.group) return;
    Promise.resolve(current.model.motion(selected.group, selected.index ?? 0, 3)).catch(onError);
  }
  function perform(line) {
    if (!line || line.id === lastLine) return;
    queuedLine = line;
    if (!current) return;
    lastLine = line.id;
    const expression = config?.expressions?.[line.face];
    if (expression !== undefined) Promise.resolve(current.model.expression(expression)).catch(onError);
    motion(line.action);
  }
  function cue(value) {
    if (!value || value.id === lastCue) return;
    queuedCue = value;
    if (!current) return;
    lastCue = value.id;
    motion(value.action);
  }
  async function mount(view, token) {
    let app = null, model = null;
    try {
      const source = localAsset(view.live2d.model, base);
      const runtime = await loadRuntime(view.live2d);
      if (dead || token !== generation) return false;
      const response = await fetchImpl(source, { cache: 'no-cache' });
      if (!response.ok) throw new Error('Live2D model manifest is unavailable');
      const settings = prepareModelSettings(await response.json(), source);
      model = await runtime.live2d.Live2DModel.from(settings, { autoInteract: false, autoUpdate: true });
      if (dead || token !== generation) { model.destroy({ children: true, texture: true, baseTexture: true }); return false; }
      app = new runtime.Application({ backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: Math.min(globalThis.devicePixelRatio || 1, 2) });
      app.stage.addChild(model);
      container.replaceChildren(app.view); container.hidden = false;
      const size = { width: model.width, height: model.height };
      const resize = () => {
        const width = container.clientWidth, height = container.clientHeight;
        if (!width || !height || !size.width || !size.height) return;
        app.renderer.resize(width, height);
        model.anchor.set(0.5, 0.5);
        model.scale.set(Math.min(width / size.width, height / size.height) * 0.98);
        model.position.set(width / 2, height / 2);
      };
      const ids = settings.Groups?.find(group => group.Target === 'Parameter' && group.Name === 'LipSync')?.Ids;
      const mouthIds = Array.isArray(ids) && ids.length ? ids.filter(id => typeof id === 'string') : ['ParamMouthOpenY'];
      const updateMouth = () => {
        const value = meter.value();
        for (const id of mouthIds) model.internalModel.coreModel.setParameterValueById(id, value);
      };
      model.internalModel.on('beforeModelUpdate', updateMouth);
      current = { app, model, updateMouth };
      if (ResizeObserver) { observer = new ResizeObserver(resize); observer.observe(container); }
      resize();
      onReady(true);
      perform(queuedLine); cue(queuedCue);
      return true;
    } catch (error) {
      if (app) app.destroy(true, { children: true, texture: true, baseTexture: true });
      else model?.destroy({ children: true, texture: true, baseTexture: true });
      if (!dead && token === generation) { container.hidden = true; onReady(false); onError(error); }
      return false;
    }
  }
  return {
    get ready() { return !!current; },
    setView(view) {
      if (dead) return Promise.resolve(false);
      if (view?.kind !== 'live2d') {
        if (key !== null) { generation++; clear(); key = config = pending = null; queuedLine = queuedCue = lastLine = lastCue = null; }
        return Promise.resolve(false);
      }
      config = view.live2d;
      const next = JSON.stringify([config?.model, config?.core, config?.pixi, config?.display]);
      if (next !== key) {
        generation++; clear(); key = next; lastLine = lastCue = null;
        pending = mount(view, generation);
      }
      cue(view.cue);
      return pending;
    },
    perform,
    resumeAudio: () => meter.resume(),
    destroy() { dead = true; generation++; clear(); meter.destroy(); },
  };
}
