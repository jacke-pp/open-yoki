# Third-party files

The MIT license in `LICENSE` covers the code written for this package. These bundled files keep their own licenses:

| File | What | License |
|---|---|---|
| `app/public/vendor/hls.min.js` | hls.js, HLS playback in the web room | Apache-2.0 (https://github.com/video-dev/hls.js) |
| `app/public/vendor/volc-rtc.min.js` | Volcengine RTC Web SDK, the live picture in the web room and the Square feed | New BSD, text in `volc-rtc.LICENSE` next to it |
| `app/relay/vendor/trtc.js` | Tencent TRTC Web SDK (`trtc.js` from the npm package `trtc-sdk-v5`, a 5.x build), used by the server-side relay page | ISC, as declared in that package's `package.json`. To update: `npm pack trtc-sdk-v5` and copy `package/trtc.js` here |
| `app/relay/fonts/kai.ttf` | LXGW WenKai | SIL Open Font License 1.1, see `app/relay/fonts/README.md` |
| `app/relay/fonts/num.ttf` | Oswald | SIL Open Font License 1.1, see `app/relay/fonts/README.md` |

npm packages (`app/package.json`) are installed at setup time, not shipped.
The folders under `tools/` list their own outside tools and models in their READMEs.

Optional Live2D assets are installed by the operator, not bundled or relicensed by this project.
`app/tools/setup-live2d.mjs` downloads pinned PixiJS (MIT) and pixi-live2d-display (MIT) bundles with their license files.
The Cubism Framework included in that display bundle and the operator-supplied Cubism Core are also subject to
[Live2D SDK licensing](https://www.live2d.com/en/sdk/license/).
Character models, textures, motions and expressions require their own permission. The optional runtime and model
directories are Git-ignored; see [local provider setup](docs/local-providers.md).

The optional Simli browser bundle is built locally with `npm run build:simli` from the pinned
`simli-client@3.2.0` npm package (MIT) and its locked dependencies, including livekit-client (Apache-2.0).
Generated legal comments and the complete bundled-package license texts are retained under
`app/public/vendor/simli/`. The generated bundle is Git-ignored. Simli's hosted service and avatar assets
remain subject to their own terms; this project's MIT license does not grant cloud-service access.
The build applies a source-checksummed compatibility patch to SDK 3.2.0 to disable automatic reconnects
and dispose session resources; the upstream MIT license is retained. New SDK versions require review.
See [Simli setup](docs/simli.md).
