// Only same-origin assets are exposed to the browser. Operators supply their
// own licensed model and Cubism Core; neither is shipped with the application.
function asset(value, fallback, name, model = false) {
  const url = value || fallback;
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || /[\\\s\x00-\x1f]/.test(url)) {
    throw new Error(`${name} must be a same-origin path starting with /`);
  }
  const parsed = new URL(url, 'http://localhost');
  if (parsed.hash || (model && !parsed.pathname.endsWith('.model3.json'))) {
    throw new Error(`${name} must point to ${model ? 'a .model3.json file' : 'an asset without a fragment'}`);
  }
  return url;
}

function expressions(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Live2D expressions must be an object');
  for (const name of Object.values(value)) {
    if (typeof name !== 'string' || !name || name.length > 128) throw new Error('Live2D expression names must be nonempty strings');
  }
  return { ...value };
}

function motions(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Live2D motions must be an object');
  const out = {};
  for (const [name, motion] of Object.entries(value)) {
    if (!motion || typeof motion.group !== 'string' || !motion.group || motion.group.length > 128 ||
        !Number.isSafeInteger(motion.index) || motion.index < 0) {
      throw new Error('Live2D motions need a group and a nonnegative integer index');
    }
    out[name] = { group: motion.group, index: motion.index };
  }
  return out;
}

export function live2dConfig(idol, env = {}) {
  const cfg = idol.avatar.live2d || {};
  const credit = env.LIVE2D_CREDIT || cfg.credit || '';
  if (typeof credit !== 'string' || credit.length > 500) throw new Error('Live2D credit must be a string of at most 500 characters');
  return {
    model: asset(env.LIVE2D_MODEL || cfg.model, '', 'LIVE2D_MODEL', true),
    core: asset(env.LIVE2D_CORE || cfg.core, '/vendor/live2d/live2dcubismcore.min.js', 'LIVE2D_CORE'),
    pixi: asset(env.LIVE2D_PIXI || cfg.pixi, '/vendor/live2d/pixi.min.js', 'LIVE2D_PIXI'),
    display: asset(env.LIVE2D_DISPLAY || cfg.display, '/vendor/live2d/cubism4.min.js', 'LIVE2D_DISPLAY'),
    expressions: expressions(cfg.expressions),
    motions: motions(cfg.motions),
    credit,
  };
}
