import { FFmpegClient, FFmpegStoppedError } from "./ffmpeg-client.js";
import {
  PICKER_EXTENSIONS,
  SOURCE_FORMAT,
  buildArgs,
  describeQuality,
  detectKind,
  expectedDuration,
  fileExtension,
  findFormat,
  formatBytes,
  formatClock,
  formatOptions,
  outputFileName,
  resolveTrim,
  summarizeFailure
} from "./media.js";

const LARGE_FILE_BYTES = 1024 ** 3;
const MAX_LOG_LINES = 400;
const PROBE_TIMEOUT_MS = 8000;
const INPUT_DIR = "/input";

const ENCODE_HINT = "Re-encodes to the chosen format and quality. Works with any input, but takes longer.";
const COPY_HINT =
  "Copies the original audio/video data into a new file: very fast and lossless. " +
  "Cuts snap to keyframes, and it fails if the original codecs don't fit the format (MKV accepts almost anything).";

const form = document.getElementById("processForm");
const optionsFieldset = document.getElementById("optionsFieldset");
const dropZone = document.getElementById("dropZone");
const sourceFileInput = document.getElementById("sourceFile");
const fileInfo = document.getElementById("fileInfo");
const modeSelect = document.getElementById("conversionMode");
const methodSelect = document.getElementById("methodSelect");
const formatSelect = document.getElementById("formatSelect");
const methodHint = document.getElementById("methodHint");
const startInput = document.getElementById("startTime");
const endInput = document.getElementById("endTime");
const durationHint = document.getElementById("durationHint");
const videoQualityInput = document.getElementById("videoQuality");
const videoQualityLabel = document.getElementById("videoQualityLabel");
const audioBitrateSelect = document.getElementById("audioBitrate");
const convertButton = document.getElementById("convertButton");
const cancelButton = document.getElementById("cancelButton");
const statusMessage = document.getElementById("statusMessage");
const progressBar = document.getElementById("progressBar");
const downloadLink = document.getElementById("downloadLink");
const engineStatus = document.getElementById("engineStatus");
const ffmpegLog = document.getElementById("ffmpegLog");

const ffmpeg = new FFmpegClient();
let source = null; // { file, kind, ext }
let mediaDuration = NaN;
let probeToken = 0;
let run = null; // { controller, expected, notice } while a conversion runs
let resultUrl = null;
let logLines = [];

ffmpeg.onLog = ({ message }) => {
  // ffmpeg.wasm prints "Aborted()" at the end of every run, including successful ones.
  if (message !== "Aborted()") appendLog(message);
};
ffmpeg.onProgress = ({ progress, time }) => {
  if (!run) return;
  // FFmpeg's own ratio is relative to the whole input, so prefer the trimmed length when known.
  setProgress(run.expected ? time / 1e6 / run.expected : progress);
};
ffmpeg.onDownloadProgress = (received, total) => {
  engineStatus.textContent = `Downloading FFmpeg engine... ${Math.round((received / total) * 100)}%`;
};

function setStatus(message, tone = "") {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${tone}`.trim();
}

function setProgress(ratio) {
  if (!Number.isFinite(ratio)) return;
  const clamped = Math.min(Math.max(ratio, 0), 1);
  progressBar.value = clamped;
  setStatus(`Converting... ${Math.round(clamped * 100)}%${run?.notice ? `\n${run.notice}` : ""}`);
}

function appendLog(line) {
  logLines.push(line);
  if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
  ffmpegLog.textContent = logLines.join("\n");
  ffmpegLog.scrollTop = ffmpegLog.scrollHeight;
}

function setBusy(busy) {
  optionsFieldset.disabled = busy;
  convertButton.disabled = busy || !source;
  cancelButton.hidden = !busy;
  progressBar.hidden = !busy;
}

function clearResult() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  downloadLink.removeAttribute("href");
  downloadLink.hidden = true;
}

function showResult(data, name, mime) {
  const blob = new Blob([data], { type: mime });
  resultUrl = URL.createObjectURL(blob);
  downloadLink.href = resultUrl;
  downloadLink.download = name;
  downloadLink.textContent = `Download ${name} (${formatBytes(blob.size)})`;
  downloadLink.hidden = false;
}

function preloadFfmpeg() {
  engineStatus.textContent = "Loading FFmpeg engine...";
  ffmpeg.load().then(
    () => (engineStatus.textContent = "FFmpeg engine ready."),
    (error) => {
      if (!(error instanceof FFmpegStoppedError)) engineStatus.textContent = `FFmpeg engine failed to load: ${error.message}`;
    }
  );
}

function refreshFormatOptions() {
  const previous = formatSelect.value;
  const options = formatOptions(modeSelect.value, methodSelect.value, source ?? { ext: "", kind: "unknown" });
  formatSelect.replaceChildren(...options.map(({ value, label }) => new Option(label, value)));
  if (options.some((option) => option.value === previous)) formatSelect.value = previous;
  updateControls();
}

function updateControls() {
  const encode = methodSelect.value === "encode";
  const format = findFormat(modeSelect.value, formatSelect.value);
  videoQualityInput.disabled = !encode || modeSelect.value === "audio";
  audioBitrateSelect.disabled = !encode || Boolean(format?.lossless);
  methodHint.textContent = encode ? ENCODE_HINT : COPY_HINT;
}

function selectFile(file) {
  clearResult();
  source = null;
  mediaDuration = NaN;
  probeToken++;
  fileInfo.classList.remove("warning");

  if (!file) {
    fileInfo.textContent = "Waiting for a file...";
    durationHint.textContent = "";
    convertButton.disabled = true;
    setStatus("Select a file to get started.");
    refreshFormatOptions();
    return;
  }

  const kind = detectKind(file.name, file.type);
  source = { file, kind, ext: fileExtension(file.name) };
  const kindLabel = { video: "Video", audio: "Audio", unknown: "Unknown type, treated as video" }[kind];
  fileInfo.textContent = `${file.name} (${formatBytes(file.size)}) - ${kindLabel}`;
  if (file.size > LARGE_FILE_BYTES) {
    fileInfo.textContent += ". Large file: conversion may be slow or run out of browser memory.";
    fileInfo.classList.add("warning");
  }

  modeSelect.value = kind === "audio" ? "audio" : "video";
  modeSelect.disabled = kind === "audio";
  refreshFormatOptions();

  convertButton.disabled = false;
  setStatus(`Ready to convert ${file.name}. Configure options and hit Process media.`);
  probeDuration(file, kind);
  preloadFfmpeg();
}

// Reads the duration with the browser's own decoder. Formats the browser can't play
// (e.g. some MKV or AVI files) report no duration; FFmpeg still converts them.
function probeDuration(file, kind) {
  const token = probeToken;
  const url = URL.createObjectURL(file);
  const probe = document.createElement(kind === "audio" ? "audio" : "video");
  durationHint.textContent = "Detecting duration...";

  const finish = (duration) => {
    clearTimeout(timer);
    probe.onloadedmetadata = probe.onerror = null;
    probe.removeAttribute("src");
    probe.load();
    URL.revokeObjectURL(url);
    if (token !== probeToken) return;
    mediaDuration = duration;
    durationHint.textContent =
      Number.isFinite(duration) && duration > 0
        ? `Detected duration: ${formatClock(duration)} (${duration.toFixed(2)} seconds)`
        : "Could not detect the duration in this browser. Trimming still works.";
  };
  const timer = setTimeout(() => finish(NaN), PROBE_TIMEOUT_MS);
  probe.preload = "metadata";
  probe.onloadedmetadata = () => finish(probe.duration);
  probe.onerror = () => finish(NaN);
  probe.src = url;
}

/** Rejects as soon as the signal aborts, even if the promise is still pending. */
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new FFmpegStoppedError());
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function processMedia(event) {
  event.preventDefault();
  if (!source || run) return;

  const trim = resolveTrim(startInput.value, endInput.value, mediaDuration);
  if (trim.error) {
    setStatus(trim.error, "error");
    return;
  }

  const { file } = source;
  const mode = modeSelect.value;
  const method = methodSelect.value;
  const keepSource = formatSelect.value === SOURCE_FORMAT;
  const outputExt = keepSource ? source.ext : formatSelect.value;
  const outputName = outputFileName(file.name, outputExt);
  const outputPath = `/output.${outputExt}`;
  const mime = keepSource ? file.type || "application/octet-stream" : findFormat(mode, outputExt).mime;
  const args = buildArgs({
    inputPath: `${INPUT_DIR}/${file.name}`,
    outputPath,
    outputExt,
    mode,
    method,
    trim,
    quality: Number(videoQualityInput.value),
    audioBitrate: Number(audioBitrateSelect.value)
  });

  clearResult();
  logLines = [];
  ffmpegLog.textContent = "";
  run = { controller: new AbortController(), expected: expectedDuration(trim, mediaDuration), notice: trim.notice };
  const { signal } = run.controller;
  const startedAt = performance.now();
  setBusy(true);
  progressBar.value = 0;
  setStatus("Loading FFmpeg engine...");
  preloadFfmpeg();

  try {
    await abortable(ffmpeg.load(), signal);
    setProgress(0);
    await ffmpeg.createDir(INPUT_DIR);
    await ffmpeg.mountFiles([file], INPUT_DIR);
    appendLog(`$ ffmpeg ${args.join(" ")}`);

    const exitCode = await ffmpeg.exec(args);
    if (exitCode !== 0) {
      const hint = method === "copy" ? "\nFast copy needs codecs that fit the chosen format. Try MKV, or Re-encode." : "";
      throw new Error(`${summarizeFailure(logLines) || `FFmpeg exited with code ${exitCode}.`}${hint}`);
    }

    const data = await ffmpeg.readFile(outputPath);
    await ffmpeg.deleteFile(outputPath);
    await ffmpeg.unmount(INPUT_DIR);
    await ffmpeg.deleteDir(INPUT_DIR);

    showResult(data, outputName, mime);
    const seconds = (performance.now() - startedAt) / 1000;
    const elapsed = seconds < 60 ? `${seconds.toFixed(1)} s` : formatClock(seconds);
    setStatus(`Done in ${elapsed}.${trim.notice ? ` ${trim.notice}` : ""}`, "success");
  } catch (error) {
    // Start from a clean FFmpeg next time: a failed run can leave files mounted or memory exhausted.
    ffmpeg.terminate();
    preloadFfmpeg();
    if (signal.aborted) {
      setStatus("Cancelled.");
    } else {
      console.error(error);
      const memoryHint = /out of memory|OOM|enlarge memory|allocation failed/i.test(error.message)
        ? "\nThe file is probably too large for browser memory."
        : "";
      setStatus(`Conversion failed:\n${error.message}${memoryHint}`, "error");
    }
  } finally {
    run = null;
    setBusy(false);
  }
}

form.addEventListener("submit", processMedia);

cancelButton.addEventListener("click", () => {
  if (!run) return;
  run.controller.abort();
  ffmpeg.terminate();
});

sourceFileInput.accept = ["audio/*", "video/*", ...PICKER_EXTENSIONS].join(",");
sourceFileInput.addEventListener("change", () => selectFile(sourceFileInput.files[0] ?? null));

modeSelect.addEventListener("change", refreshFormatOptions);
formatSelect.addEventListener("change", updateControls);
methodSelect.addEventListener("change", () => {
  refreshFormatOptions();
  const canKeepSource = [...formatSelect.options].some((option) => option.value === SOURCE_FORMAT);
  if (methodSelect.value === "copy" && canKeepSource) formatSelect.value = SOURCE_FORMAT;
  updateControls();
});

videoQualityInput.addEventListener("input", () => {
  videoQualityLabel.textContent = describeQuality(Number(videoQualityInput.value));
});

// Accept a file dropped anywhere, and stop the browser from opening it in place of the page.
document.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = run ? "none" : "copy";
  dropZone.classList.add("dragging");
});
document.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) dropZone.classList.remove("dragging");
});
document.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  event.preventDefault();
  dropZone.classList.remove("dragging");
  if (run) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  sourceFileInput.files = transfer.files;
  selectFile(file);
});

window.addEventListener("beforeunload", (event) => {
  if (run) event.preventDefault();
});

refreshFormatOptions();
videoQualityLabel.textContent = describeQuality(Number(videoQualityInput.value));
