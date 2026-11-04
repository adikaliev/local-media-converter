// Pure helpers for choosing formats and building FFmpeg arguments.
// No DOM access here, so everything can be unit-tested in Node.

export const SOURCE_FORMAT = "source";

export const QUALITY = { min: 15, max: 35, default: 23 };

const EVEN_SIZE = "scale=trunc(iw/2)*2:trunc(ih/2)*2"; // H.264/VP8 with yuv420p need even width and height
const FASTSTART_EXTS = new Set(["mp4", "m4v", "m4a", "mov"]);

// The quality slider uses the x264 CRF scale; other encoders get a matching value.
const vp8Crf = (quality) => quality - 11;
const mpeg4Q = (quality) => Math.round((quality - QUALITY.min) / 2) + 2;

// Measured on 5 s of 720p: ultrafast took 9 s and made 3.7 MB; veryfast took 23 s and made 1.4 MB.
const H264_PRESETS = { balanced: "veryfast", fast: "ultrafast" };

const h264 = (quality, speed = "balanced") => [
  "-c:v", "libx264", "-preset", H264_PRESETS[speed], "-crf", String(quality), "-pix_fmt", "yuv420p", "-vf", EVEN_SIZE
];

export const FORMATS = {
  video: [
    {
      ext: "mp4",
      name: "MP4",
      codecs: "H.264 + AAC",
      mime: "video/mp4",
      usesSpeed: true,
      encodeArgs: ({ quality, audioBitrate, speed }) => [...h264(quality, speed), "-c:a", "aac", "-b:a", `${audioBitrate}k`]
    },
    {
      ext: "mkv",
      name: "MKV",
      codecs: "H.264 + AAC",
      mime: "video/x-matroska",
      usesSpeed: true,
      encodeArgs: ({ quality, audioBitrate, speed }) => [...h264(quality, speed), "-c:a", "aac", "-b:a", `${audioBitrate}k`]
    },
    {
      // VP8 rather than VP9: libvpx-vp9 crashes ("memory access out of bounds") in @ffmpeg/core 0.12.10.
      ext: "webm",
      name: "WebM",
      codecs: "VP8 + Opus",
      mime: "video/webm",
      encodeArgs: ({ quality, audioBitrate }) => [
        "-c:v", "libvpx", "-crf", String(vp8Crf(quality)),
        "-deadline", "good", "-cpu-used", "4", "-pix_fmt", "yuv420p", "-vf", EVEN_SIZE,
        // Opus allows at most 256 kbps per channel, so cap it for mono sources.
        "-c:a", "libopus", "-b:a", `${Math.min(audioBitrate, 256)}k`
      ]
    },
    {
      ext: "avi",
      name: "AVI",
      codecs: "MPEG-4 + MP3",
      mime: "video/x-msvideo",
      encodeArgs: ({ quality, audioBitrate }) => [
        "-c:v", "mpeg4", "-q:v", String(mpeg4Q(quality)), "-vf", EVEN_SIZE,
        "-c:a", "libmp3lame", "-b:a", `${audioBitrate}k`
      ]
    }
  ],
  audio: [
    { ext: "mp3", name: "MP3", mime: "audio/mpeg", encodeArgs: ({ audioBitrate }) => ["-c:a", "libmp3lame", "-b:a", `${audioBitrate}k`] },
    { ext: "m4a", name: "M4A", codecs: "AAC", mime: "audio/mp4", encodeArgs: ({ audioBitrate }) => ["-c:a", "aac", "-b:a", `${audioBitrate}k`] },
    { ext: "wav", name: "WAV", codecs: "uncompressed", mime: "audio/wav", lossless: true, encodeArgs: () => ["-c:a", "pcm_s16le"] },
    { ext: "flac", name: "FLAC", codecs: "lossless", mime: "audio/flac", lossless: true, encodeArgs: () => ["-c:a", "flac"] }
  ]
};

const VIDEO_EXTS = new Set([
  "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "asf", "flv", "f4v", "ts", "mts", "m2ts",
  "3gp", "3g2", "ogv", "mpg", "mpeg", "vob", "mxf", "divx", "rm", "rmvb"
]);
const AUDIO_EXTS = new Set([
  "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "wma", "aiff", "aif", "amr", "ac3", "mka", "weba", "caf"
]);

/** Extensions to list in the file picker next to audio/* and video/*, which some systems don't map (e.g. .mkv on Windows). */
export const PICKER_EXTENSIONS = [...VIDEO_EXTS, ...AUDIO_EXTS].map((ext) => `.${ext}`);

export function fileExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** "video", "audio" or "unknown". Falls back to the extension because browsers often report no type (e.g. .mkv on Windows). */
export function detectKind(name, mimeType = "") {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  const ext = fileExtension(name);
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "unknown";
}

export function findFormat(mode, ext) {
  return FORMATS[mode].find((format) => format.ext === ext) ?? null;
}

/** Options for the format dropdown. Copy mode can also keep the source container. */
export function formatOptions(mode, method, source) {
  const options = FORMATS[mode].map((format) => ({
    value: format.ext,
    label: method === "encode" && format.codecs ? `${format.name} (${format.codecs})` : format.name
  }));
  if (method === "copy" && source.ext && source.kind === mode) {
    options.unshift({ value: SOURCE_FORMAT, label: `Same as source (.${source.ext})` });
  }
  return options;
}

/** Parses "90", "90.5", "1:30" or "1:02:03.5" into seconds. Empty → null, invalid → NaN. */
export function parseTime(text) {
  const value = text.trim().replace(",", ".");
  if (value === "") return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(value)) return NaN;
  const parts = value.split(":").map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * Validates the trim fields against the media duration (NaN or 0 when unknown).
 * Returns { start, end } (end is null for "to the end"), plus an optional notice, or { error }.
 */
export function resolveTrim(startText, endText, duration) {
  const start = parseTime(startText) ?? 0;
  const end = parseTime(endText);
  if (Number.isNaN(start)) return { error: "Start time must be in seconds (90) or minutes:seconds (1:30)." };
  if (Number.isNaN(end)) return { error: "End time must be in seconds (90) or minutes:seconds (1:30)." };
  if (end !== null && end <= start) return { error: "End time must be after the start time." };

  const known = Number.isFinite(duration) && duration > 0;
  if (known && start >= duration) {
    return { error: `Start time is past the end of the media (${formatClock(duration)}).` };
  }
  if (known && end !== null && end > duration) {
    return { start, end: null, notice: "End time is past the end of the media, so the output runs to the end." };
  }
  return { start, end };
}

/** Expected output length in seconds, or null when the media duration is unknown and no end is set. */
export function expectedDuration(trim, duration) {
  if (trim.end !== null) return trim.end - trim.start;
  if (Number.isFinite(duration) && duration > 0) return duration - trim.start;
  return null;
}

/**
 * Turns an FFmpeg progress event into a 0-1 ratio, or null if the event is unusable.
 * The engine sometimes starts a run with a garbage time (INT64_MAX), which would read as 100%.
 */
export function progressRatio({ progress, time }, expected) {
  if (!Number.isFinite(time) || time < 0 || time > Number.MAX_SAFE_INTEGER) return null;
  // FFmpeg's own ratio is relative to the whole input, so prefer the trimmed length when known.
  const ratio = expected ? time / 1e6 / expected : progress;
  return Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : null;
}

export function buildArgs({ inputPath, outputPath, outputExt, mode, method, trim, quality, audioBitrate, speed }) {
  const args = ["-hide_banner"];
  if (trim.start > 0) args.push("-ss", formatSeconds(trim.start));
  if (trim.end !== null) args.push("-t", formatSeconds(trim.end - trim.start));
  args.push("-i", inputPath);

  // Keep the main video and audio track only: subtitle and data tracks often can't go into the target container.
  if (mode === "audio") args.push("-vn");
  args.push("-sn", "-dn");

  if (method === "copy") {
    args.push(...(mode === "audio" ? ["-c:a", "copy"] : ["-c", "copy"]), "-avoid_negative_ts", "make_zero");
  } else {
    const format = findFormat(mode, outputExt);
    if (!format) throw new Error(`Unsupported ${mode} format: ${outputExt}`);
    args.push(...format.encodeArgs({ quality, audioBitrate, speed }));
  }

  if (FASTSTART_EXTS.has(outputExt)) args.push("-movflags", "+faststart");
  args.push(outputPath);
  return args;
}

export function outputFileName(sourceName, ext) {
  const dot = sourceName.lastIndexOf(".");
  const base = (dot > 0 ? sourceName.slice(0, dot) : sourceName) || "converted";
  const suffix = fileExtension(sourceName) === ext ? "-converted" : "";
  return `${base}${suffix}.${ext}`;
}

export function describeQuality(quality) {
  if (quality <= 18) return `${quality} - visually lossless`;
  if (quality <= 23) return `${quality} - balanced`;
  if (quality <= 28) return `${quality} - lean`;
  return `${quality} - small`;
}

/** Picks the most useful lines from the end of an FFmpeg log to explain a failure. */
export function summarizeFailure(logLines) {
  const recent = logLines.slice(-40);
  const errors = recent.filter((line) =>
    /error|invalid|not supported|unsupported|could not|unable|failed|no such|not found|incorrect|does not|only .* supported/i.test(line)
  );
  return (errors.length ? errors : recent).slice(-3).join("\n");
}

function formatSeconds(seconds) {
  return String(Number(seconds.toFixed(3)));
}

export function formatClock(seconds) {
  const total = Math.round(Math.max(0, seconds) * 100) / 100;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = (total % 60).toFixed(2).padStart(5, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

export function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
