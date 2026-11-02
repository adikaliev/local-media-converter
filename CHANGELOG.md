# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-11-02

### Fixed

- FFmpeg never loaded, so no conversion could run. The CDN URLs pointed at a file that doesn't exist in
  `@ffmpeg/ffmpeg` 0.12.6, and the code used the 0.11 API, which 0.12 removed.
- WebM output always failed: a later `-c:a aac` overrode Opus, and WebM can't hold AAC. AVI output got AAC instead of MP3.
- The page stayed locked after an FFmpeg loading error.
- Files the browser reports without a type (common for `.mkv` on Windows) were treated as audio-only.
- The "Download result" link was visible before any conversion, because CSS overrode the `hidden` attribute.
- Each conversion leaked a full copy of its output in memory; old download URLs were never released.
- Dropdown lists could show light text on a light background when the OS uses a light theme.
- A loading error message was overwritten by the next status line.

### Added

- **Fast copy** method (no re-encoding), including a "Same as source" format for trimming without conversion.
- MKV output.
- Progress bar, live FFmpeg log and a Cancel button.
- Trim validation against the detected duration. Times can be seconds or `m:ss` / `h:mm:ss`.
- Drag and drop anywhere on the page.
- "Good to know" panel that explains the limitations to users, plus a warning for files over 1 GB.
- FFmpeg starts downloading as soon as a file is selected.
- Every FFmpeg file is verified against a pinned SHA-384 hash. unpkg is the fallback CDN when jsDelivr fails.
- Unit tests (`node:test`), end-to-end tests (Playwright), a zero-dependency dev server, and project docs.

### Changed

- FFmpeg is pinned to `@ffmpeg/ffmpeg` 0.12.15 and `@ffmpeg/core` 0.12.10, the latest releases, loaded from jsDelivr.
  The single-threaded build needs no special server headers, so the app runs on GitHub Pages.
- Input files are mounted with WORKERFS instead of being copied into WebAssembly memory.
- H.264 uses the `veryfast` preset. In tests it was about 2× faster than `medium` with nearly the same file size.
- WebM uses VP8 + Opus. `libvpx-vp9` crashes in this FFmpeg build.
- AAC audio output is saved as `.m4a` instead of raw `.aac`.
- Video output uses `yuv420p` and even dimensions, so it plays in browsers and QuickTime.
- Subtitle and data tracks are dropped; they often can't be stored in the target container.
- Audio bitrate is disabled for lossless formats. Quality controls are disabled for fast copy.
- When the output has the same extension as the source, it is named `<name>-converted.<ext>`.
- CSS moved to `styles.css`, and the JavaScript is split into modules under `js/`.

## [0.1.0] - 2025-11-30

### Added

- Single-page converter on ffmpeg.wasm: convert video or audio, trim, and set quality.
