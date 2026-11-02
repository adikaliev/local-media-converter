// Loads ffmpeg.wasm from public CDNs and runs it in a Web Worker.
//
// Browsers only start workers from same-origin URLs, so the library's FFmpeg class
// can't be used straight from a CDN. Instead we download the library's prebuilt
// worker script (814.ffmpeg.js), start it from a blob: URL, and talk to it with the
// same message protocol the FFmpeg class uses.
//
// Versions are pinned and every file is checked against its SHA-384 hash, so a
// changed or tampered CDN file is rejected. README.md explains how to upgrade.

const CDN_BASES = ["https://cdn.jsdelivr.net/npm", "https://unpkg.com"];

const ASSETS = [
  {
    key: "worker",
    path: "@ffmpeg/ffmpeg@0.12.15/dist/umd/814.ffmpeg.js",
    type: "text/javascript",
    size: 3177,
    sha384: "l2rTJ2R1KC9EDzuYSDeAvUOs6h0dm+YGX1oFKW7pn2e23NJ+JGHsFM+aPczr7nrr"
  },
  {
    key: "core",
    path: "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js",
    type: "text/javascript",
    size: 112059,
    sha384: "sKfkiFtvUk+vexk+0EUhEh366190/4WpgUAsUvaxEfyg7+E1Zt5Y5hrsU808g8Q9"
  },
  {
    key: "wasm",
    path: "@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm",
    type: "application/wasm",
    size: 32232419,
    sha384: "U1VDhkPYrM3wTCT4/vjSpSsKqG/UjljYrYCI4hBSJ02svbCkxuCi6U6u/peg5vpW"
  }
];

const TOTAL_SIZE = ASSETS.reduce((sum, asset) => sum + asset.size, 0);

export class FFmpegStoppedError extends Error {
  constructor() {
    super("FFmpeg was stopped.");
    this.name = "FFmpegStoppedError";
  }
}

export class FFmpegClient {
  /** Called with { type, message } for every FFmpeg log line. */
  onLog = null;
  /** Called with { progress, time } while a command runs; time is in microseconds. */
  onProgress = null;
  /** Called with (receivedBytes, totalBytes) while the FFmpeg files download. */
  onDownloadProgress = null;

  #downloading = null;
  #loading = null;
  #worker = null;
  #generation = 0;
  #nextId = 0;
  #pending = new Map();

  /** Downloads FFmpeg once, then starts it. Safe to call repeatedly; concurrent calls share one load. */
  load() {
    if (!this.#loading) {
      const loading = this.#start().catch((error) => {
        if (this.#loading === loading) {
          this.#loading = null;
          this.#worker?.terminate();
          this.#worker = null;
        }
        throw error;
      });
      this.#loading = loading;
    }
    return this.#loading;
  }

  /** Runs FFmpeg with the given arguments and resolves with its exit code (0 = success). */
  exec(args) {
    return this.#send("EXEC", { args, timeout: -1 });
  }

  createDir(path) {
    return this.#send("CREATE_DIR", { path });
  }

  deleteDir(path) {
    return this.#send("DELETE_DIR", { path });
  }

  /** Mounts File objects read-only at mountPoint, without copying them into WebAssembly memory. */
  mountFiles(files, mountPoint) {
    return this.#send("MOUNT", { fsType: "WORKERFS", options: { files }, mountPoint });
  }

  unmount(mountPoint) {
    return this.#send("UNMOUNT", { mountPoint });
  }

  readFile(path) {
    return this.#send("READ_FILE", { path, encoding: "binary" });
  }

  deleteFile(path) {
    return this.#send("DELETE_FILE", { path });
  }

  /** Kills the worker at once, rejecting every pending call. Downloaded files are kept, so load() is quick afterwards. */
  terminate(reason = new FFmpegStoppedError()) {
    this.#generation++;
    this.#worker?.terminate();
    this.#worker = null;
    this.#loading = null;
    for (const { reject } of this.#pending.values()) reject(reason);
    this.#pending.clear();
  }

  async #start() {
    const generation = this.#generation;
    const urls = await this.#download();
    if (generation !== this.#generation) throw new FFmpegStoppedError();

    this.#worker = new Worker(urls.worker);
    this.#worker.onmessage = ({ data }) => this.#receive(data);
    this.#worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error(`FFmpeg worker crashed: ${event.message || "unknown error"}`));
    };
    await this.#send("LOAD", { coreURL: urls.core, wasmURL: urls.wasm });
  }

  #download() {
    this.#downloading ??= downloadAssets((received) => this.onDownloadProgress?.(received, TOTAL_SIZE)).catch((error) => {
      this.#downloading = null;
      throw error;
    });
    return this.#downloading;
  }

  #send(type, data) {
    if (!this.#worker) return Promise.reject(new Error("FFmpeg is not loaded."));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, type, data });
    });
  }

  #receive({ id, type, data }) {
    if (type === "LOG") return this.onLog?.(data);
    if (type === "PROGRESS") return this.onProgress?.(data);
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (type === "ERROR") pending.reject(new Error(data));
    else pending.resolve(data);
  }
}

/** Downloads and verifies all assets in parallel. Resolves with blob: URLs keyed by asset key. */
async function downloadAssets(onProgress) {
  if (!globalThis.crypto?.subtle) {
    throw new Error("This page must be opened over HTTPS or from localhost, so the FFmpeg files can be verified.");
  }
  const received = new Map();
  const report = () => onProgress([...received.values()].reduce((sum, bytes) => sum + bytes, 0));

  const entries = await Promise.all(
    ASSETS.map(async (asset) => {
      const url = await fetchVerified(asset, (bytes) => {
        received.set(asset.key, bytes);
        report();
      });
      return [asset.key, url];
    })
  );
  return Object.fromEntries(entries);
}

async function fetchVerified(asset, onProgress) {
  const failures = [];
  for (const base of CDN_BASES) {
    const url = `${base}/${asset.path}`;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await readBody(response, onProgress);
      if ((await sha384(bytes)) !== asset.sha384) throw new Error("file does not match its pinned SHA-384 hash");
      return URL.createObjectURL(new Blob([bytes], { type: asset.type }));
    } catch (error) {
      onProgress(0);
      failures.push(`${url}: ${error.message}`);
    }
  }
  throw new Error(`Could not download FFmpeg.\n${failures.join("\n")}`);
}

// Reads the body in chunks to report progress. Content-Length can't be used for the
// total because CDNs send compressed bytes, so callers use the known file sizes instead.
async function readBody(response, onProgress) {
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

async function sha384(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-384", bytes));
  return btoa(String.fromCharCode(...digest));
}
