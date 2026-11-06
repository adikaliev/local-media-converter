# Media Converter: agent instructions

The repo, package and local folder are all named `local-media-converter`.

Browser-only audio/video converter built on ffmpeg.wasm and hosted as a static site on GitHub Pages. Read
[README.md](README.md) for setup, limitations and the FFmpeg upgrade steps.

## Hard rules

- **No uploads, no backend, no analytics.** All processing stays in the visitor's browser. That privacy promise is
  the point of the app.
- **Must run on plain static hosting.** GitHub Pages can't set headers, so nothing may depend on COOP/COEP or
  `SharedArrayBuffer`. That rules out the multi-threaded `@ffmpeg/core-mt`.
- **FFmpeg comes from the CDN at pinned versions, verified by SHA-384.** Never use `latest` or unpinned URLs, and
  never skip the hash check. Don't commit FFmpeg binaries to the repo. Upgrades follow README.md.
- **No build step and no runtime dependencies.** The site is plain HTML, CSS and native ES modules. npm packages are
  dev-only (tests).

## Code layout

- `js/media.js`: pure logic (formats, FFmpeg arguments, trim parsing). No DOM or browser APIs, so it runs under
  `node --test`. Put new logic here and unit-test it.
- `js/ffmpeg-client.js`: CDN download, hash check, and a small client for the `@ffmpeg/ffmpeg` worker's message
  protocol (`LOAD`, `EXEC`, `MOUNT`, …).
- `js/app.js`: DOM wiring only.
- Each format in `FORMATS` carries its full encoder argument list. Don't append shared codec flags after it: FFmpeg
  uses the last value of a repeated option, and that once broke WebM by forcing AAC audio.

## ffmpeg.wasm quirks

- `exec()` resolves with FFmpeg's exit code. A non-zero code is a failure; it doesn't throw.
- Crashes such as `RuntimeError: memory access out of bounds` reject the call. After any failure or cancel the app
  calls `terminate()` and reloads, because the instance may be in a bad state. Reloading is quick: the downloaded
  files are kept as blob URLs.
- Every run logs a final `Aborted()` line, even on success. The app hides it.
- A run can start with a garbage progress event (`time` is INT64_MAX). `progressRatio` in `js/media.js` drops it.
- `libvpx-vp9` crashes in `@ffmpeg/core` 0.12.10 with any settings, so WebM uses VP8.
- Input files are mounted with WORKERFS, not copied into memory. Output still lives in WebAssembly memory, which is
  capped at 2 GB.
- CDN responses are compressed, so download progress uses the known file sizes, not `Content-Length`.

## Testing

- `npm test` runs unit and end-to-end tests. `npm run test:e2e` needs internet, because it fetches FFmpeg from the CDN.
- Add a unit test for any change to `js/media.js`, and an end-to-end case for any new output format or method.
- Check output files properly when you can, for example with `ffprobe` on files saved from a test. A file that only
  has the right first bytes can still be wrong.

## Documentation

- Record notable changes in [CHANGELOG.md](CHANGELOG.md).
- The limitations live in two places: README.md and the "Good to know" panel in `index.html`. Keep them in sync.
