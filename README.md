# Media Converter

Convert, trim and export audio or video in the browser. Conversion runs on the visitor's own machine with
[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), so files are never uploaded. The app is a static page with
no build step, made to be hosted on GitHub Pages.

## Features

- Video to MP4 (H.264 + AAC), MKV (H.264 + AAC), WebM (VP8 + Opus) or AVI (MPEG-4 + MP3)
- Audio only to MP3, M4A (AAC), WAV or FLAC
- **Fast copy**: changes the container or trims without re-encoding. Almost instant and lossless.
- Trim by start/end time, in seconds (`90`) or `m:ss` / `h:mm:ss` (`1:30`)
- Video quality slider and audio bitrate
- Progress bar, live FFmpeg log, Cancel button, drag and drop

## Limitations

These are also shown to users in the page's "Good to know" panel. Keep both lists in sync.

| Area | Limitation |
|---|---|
| First use | The FFmpeg engine (32 MB, about 9 MB compressed) downloads from jsDelivr, or unpkg as fallback, then the browser caches it. Networks that block both CDNs can't use the app. |
| Speed | The single-threaded FFmpeg build runs on one CPU core, much slower than desktop FFmpeg. The faster multi-threaded build needs `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers, which GitHub Pages can't send. |
| Size | WebAssembly memory is capped at 2 GB, and lower on phones. The input file is streamed, but the output has to fit in memory. Very large files fail. |
| Fast copy | Cuts snap to the previous keyframe, so the result can start earlier than requested. It fails when the source codecs don't fit the target container; MKV accepts almost anything. |
| Tracks | Only the default video and audio track are kept. Subtitles, data tracks and extra audio tracks are dropped. |
| Color | Output is 8-bit `yuv420p`. HDR and 10-bit sources lose their HDR look. |
| WebM | Uses VP8, because `libvpx-vp9` crashes in `@ffmpeg/core` 0.12.10. |
| Duration | Detected with the browser's own decoder. Formats the browser can't play (some MKV or AVI files) show no duration; conversion still works, but trim times aren't checked against the length. |
| Security | The page must be served over HTTPS or from `localhost`. It needs `crypto.subtle` to verify the FFmpeg files. |
| Browsers | Recent desktop Chrome, Edge, Firefox and Safari. The automated tests run in Chromium only. Phones may handle small files but are untested. |

## Setup

Requires [Node.js](https://nodejs.org/) 22 or later. Node is only used for the dev server and tests; the app itself has
no runtime dependencies. The commands are the same in PowerShell and bash:

```sh
npm install
npx playwright install chromium   # browser for the end-to-end tests, stored outside the project
```

`node_modules` stays in the project folder (git-ignored), as Node requires.

## Run locally

```sh
npm start
```

Then open <http://127.0.0.1:8000/>. To use another port, copy `.env.example` to `.env` and change `PORT`, or set the
`PORT` environment variable.

Without Node, any static server works, for example `python -m http.server 8000`, then open <http://localhost:8000/>.
Opening `index.html` straight from disk doesn't work, because browsers block ES modules on `file://`. A LAN address
such as `http://192.168.x.x` doesn't work either, because it isn't a secure context.

## Test

```sh
npm test            # unit + end-to-end
npm run test:unit   # js/media.js with node:test, offline, under a second
npm run test:e2e    # Playwright + Chromium against the dev server; needs internet to fetch FFmpeg from the CDN
```

The end-to-end tests convert `tests/fixtures/sample.webm` to every format. It is a 3-second 161×121 VP8/Opus clip; the
odd size is on purpose, to check that output dimensions are rounded to even numbers. They also cover trimming, fast
copy, failure recovery and Cancel.

## Deploy to GitHub Pages

1. Push the repository to GitHub as `local-media-converter`. On the Free plan, Pages requires a public repository;
   private repositories need Pro, Team or Enterprise.
2. In the repository, open **Settings → Pages** and choose **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. The site is published at `https://<user>.github.io/local-media-converter/`.

`.nojekyll` turns off Jekyll processing, so files are served as they are. No headers or build step are needed.

## FFmpeg version and upgrades

FFmpeg is loaded from public CDNs at pinned versions, not bundled in the repository. The versions, file sizes and
SHA-384 hashes are in `ASSETS` in [js/ffmpeg-client.js](js/ffmpeg-client.js):

| Package | Version | Files |
|---|---|---|
| `@ffmpeg/ffmpeg` | 0.12.15 | `dist/umd/814.ffmpeg.js` (the worker) |
| `@ffmpeg/core` | 0.12.10 | `dist/umd/ffmpeg-core.js`, `dist/umd/ffmpeg-core.wasm` |

The page downloads these files, checks every hash, and starts the worker from a `blob:` URL. A browser only starts
workers from the page's own origin, which is why the library's `FFmpeg` class can't be loaded straight from a CDN.
If a file doesn't match its hash, it is rejected.

To upgrade:

1. Find the new file names. The worker chunk is called `814.ffmpeg.js` in 0.12.15, and webpack may rename it in other
   versions; check the package's `dist/umd/` folder on jsDelivr.
2. Get each file's size and hash:

   ```sh
   npm run hash -- https://cdn.jsdelivr.net/npm/@ffmpeg/core@<version>/dist/umd/ffmpeg-core.wasm
   ```

3. Update `path`, `size` and `sha384` in `ASSETS`.
4. If the new version changes the worker's message protocol, update `FFmpegClient`. Compare against the library's
   `dist/esm/worker.js`.
5. Run `npm test`. Also check whether `libvpx-vp9` works again; if it does, WebM could go back to VP9 in
   [js/media.js](js/media.js).

## Project structure

```
index.html              page markup
styles.css              styles
js/app.js               UI wiring: file selection, options, progress, cancel, download
js/media.js             pure logic: formats, FFmpeg arguments, trim parsing (unit-tested, no DOM)
js/ffmpeg-client.js     downloads and verifies FFmpeg, runs it in a Web Worker
scripts/serve.mjs       zero-dependency static dev server (no special headers, like GitHub Pages)
scripts/hash-asset.mjs  prints size and SHA-384 of a URL, for FFmpeg upgrades
tests/unit/             node:test unit tests
tests/e2e/              Playwright end-to-end tests
tests/fixtures/         test media
```
