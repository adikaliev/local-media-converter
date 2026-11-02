import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  SOURCE_FORMAT,
  buildArgs,
  detectKind,
  expectedDuration,
  fileExtension,
  formatClock,
  formatOptions,
  outputFileName,
  parseTime,
  resolveTrim,
  summarizeFailure
} from "../../js/media.js";

const base = {
  inputPath: "/input/clip.mkv",
  outputPath: "/output.mp4",
  outputExt: "mp4",
  mode: "video",
  method: "encode",
  trim: { start: 0, end: null },
  quality: 23,
  audioBitrate: 192
};

/** Value that follows the last occurrence of an option, as FFmpeg would read it. */
function lastValue(args, option) {
  const index = args.lastIndexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

describe("parseTime", () => {
  test("reads seconds, minutes:seconds and hours:minutes:seconds", () => {
    assert.equal(parseTime("90"), 90);
    assert.equal(parseTime("12.5"), 12.5);
    assert.equal(parseTime("12,5"), 12.5);
    assert.equal(parseTime("1:30"), 90);
    assert.equal(parseTime("01:02:03.5"), 3723.5);
    assert.equal(parseTime("  7 "), 7);
  });

  test("returns null for empty input and NaN for invalid input", () => {
    assert.equal(parseTime(""), null);
    assert.equal(parseTime("   "), null);
    for (const bad of ["-1", "abc", "1:75", "1::2", "1.5:30", "1:2:3:4"]) {
      assert.ok(Number.isNaN(parseTime(bad)), bad);
    }
  });
});

describe("resolveTrim", () => {
  test("defaults to the whole file", () => {
    assert.deepEqual(resolveTrim("", "", 10), { start: 0, end: null });
  });

  test("rejects invalid or reversed ranges", () => {
    assert.match(resolveTrim("x", "", 10).error, /Start time/);
    assert.match(resolveTrim("", "y", 10).error, /End time/);
    assert.match(resolveTrim("5", "5", 10).error, /after the start/);
    assert.match(resolveTrim("6", "2", 10).error, /after the start/);
  });

  test("rejects a start past the end of the media", () => {
    assert.match(resolveTrim("12", "", 10).error, /past the end/);
  });

  test("runs to the end when the end time is past the duration", () => {
    const trim = resolveTrim("2", "30", 10);
    assert.equal(trim.start, 2);
    assert.equal(trim.end, null);
    assert.match(trim.notice, /runs to the end/);
  });

  test("skips duration checks when the duration is unknown", () => {
    assert.deepEqual(resolveTrim("100", "200", NaN), { start: 100, end: 200 });
  });
});

describe("expectedDuration", () => {
  test("uses the trim range, then the media duration", () => {
    assert.equal(expectedDuration({ start: 2, end: 5 }, 10), 3);
    assert.equal(expectedDuration({ start: 2, end: null }, 10), 8);
    assert.equal(expectedDuration({ start: 0, end: null }, NaN), null);
  });
});

describe("detectKind", () => {
  test("uses the MIME type when present", () => {
    assert.equal(detectKind("a.bin", "video/mp4"), "video");
    assert.equal(detectKind("a.bin", "audio/mpeg"), "audio");
  });

  test("falls back to the extension when the browser reports no type", () => {
    assert.equal(detectKind("Movie.MKV", ""), "video");
    assert.equal(detectKind("song.flac", ""), "audio");
    assert.equal(detectKind("notes.txt", ""), "unknown");
    assert.equal(detectKind("noextension", ""), "unknown");
  });
});

describe("buildArgs", () => {
  test("MP4 uses H.264 with browser-friendly pixel format and even dimensions", () => {
    const args = buildArgs(base);
    assert.equal(lastValue(args, "-c:v"), "libx264");
    assert.equal(lastValue(args, "-preset"), "veryfast");
    assert.equal(lastValue(args, "-crf"), "23");
    assert.equal(lastValue(args, "-pix_fmt"), "yuv420p");
    assert.match(lastValue(args, "-vf"), /trunc\(iw\/2\)\*2/);
    assert.equal(lastValue(args, "-c:a"), "aac");
    assert.equal(lastValue(args, "-b:a"), "192k");
    assert.equal(lastValue(args, "-movflags"), "+faststart");
    assert.equal(args.at(-1), "/output.mp4");
  });

  test("WebM keeps Opus audio (regression: a later -c:a aac used to override it)", () => {
    const args = buildArgs({ ...base, outputExt: "webm", outputPath: "/output.webm", audioBitrate: 320 });
    assert.equal(lastValue(args, "-c:v"), "libvpx");
    assert.equal(lastValue(args, "-c:a"), "libopus");
    assert.equal(lastValue(args, "-b:a"), "256k", "Opus bitrate is capped");
    assert.equal(lastValue(args, "-crf"), "12", "slider value is mapped to the VP8 scale");
    assert.equal(lastValue(args, "-cpu-used"), "4");
  });

  test("AVI keeps MP3 audio and maps quality to -q:v", () => {
    const args = buildArgs({ ...base, outputExt: "avi", outputPath: "/output.avi", quality: 15 });
    assert.equal(lastValue(args, "-c:v"), "mpeg4");
    assert.equal(lastValue(args, "-q:v"), "2");
    assert.equal(lastValue(args, "-c:a"), "libmp3lame");
    assert.ok(!args.includes("-crf"));
  });

  test("audio mode drops video and lossless formats get no bitrate", () => {
    const wav = buildArgs({ ...base, mode: "audio", outputExt: "wav", outputPath: "/output.wav" });
    assert.ok(wav.includes("-vn"));
    assert.equal(lastValue(wav, "-c:a"), "pcm_s16le");
    assert.ok(!wav.includes("-b:a"));

    const flac = buildArgs({ ...base, mode: "audio", outputExt: "flac", outputPath: "/output.flac" });
    assert.equal(lastValue(flac, "-c:a"), "flac");
    assert.ok(!flac.includes("-b:a"));

    const m4a = buildArgs({ ...base, mode: "audio", outputExt: "m4a", outputPath: "/output.m4a" });
    assert.equal(lastValue(m4a, "-c:a"), "aac");
    assert.equal(lastValue(m4a, "-movflags"), "+faststart");
  });

  test("fast copy copies streams without encoder options", () => {
    const video = buildArgs({ ...base, method: "copy", outputExt: "mkv", outputPath: "/output.mkv" });
    assert.equal(lastValue(video, "-c"), "copy");
    assert.equal(lastValue(video, "-avoid_negative_ts"), "make_zero");
    assert.ok(!video.includes("-crf") && !video.includes("-c:v"));

    const audio = buildArgs({ ...base, method: "copy", mode: "audio", outputExt: "m4a", outputPath: "/output.m4a" });
    assert.ok(audio.includes("-vn"));
    assert.equal(lastValue(audio, "-c:a"), "copy");
  });

  test("trim seeks before the input and limits the duration", () => {
    const args = buildArgs({ ...base, trim: { start: 1.5, end: 4 } });
    const input = args.indexOf("-i");
    assert.equal(args[args.indexOf("-ss") + 1], "1.5");
    assert.equal(args[args.indexOf("-t") + 1], "2.5");
    assert.ok(args.indexOf("-ss") < input && args.indexOf("-t") < input);
    assert.ok(!buildArgs(base).includes("-ss"), "no seek without a start time");
  });

  test("drops subtitle and data tracks", () => {
    const args = buildArgs(base);
    assert.ok(args.includes("-sn") && args.includes("-dn"));
  });

  test("rejects unknown formats when re-encoding", () => {
    assert.throws(() => buildArgs({ ...base, outputExt: "xyz" }), /Unsupported/);
  });
});

describe("formatOptions", () => {
  const source = { ext: "mkv", kind: "video" };

  test("re-encode lists formats with codecs", () => {
    const options = formatOptions("video", "encode", source);
    assert.equal(options[0].label, "MP4 (H.264 + AAC)");
    assert.ok(!options.some((option) => option.value === SOURCE_FORMAT));
  });

  test("fast copy offers the source container first when the kind matches", () => {
    const options = formatOptions("video", "copy", source);
    assert.deepEqual(options[0], { value: SOURCE_FORMAT, label: "Same as source (.mkv)" });
    assert.equal(options[1].label, "MP4");
    assert.ok(!formatOptions("audio", "copy", source).some((option) => option.value === SOURCE_FORMAT));
  });
});

describe("file names and formatting", () => {
  test("outputFileName swaps the extension and avoids reusing the source name", () => {
    assert.equal(outputFileName("holiday.mov", "mp4"), "holiday.mp4");
    assert.equal(outputFileName("holiday.mp4", "mp4"), "holiday-converted.mp4");
    assert.equal(outputFileName("my.clip.v2.webm", "mp3"), "my.clip.v2.mp3");
    assert.equal(outputFileName(".mp4", "mp3"), ".mp4.mp3");
  });

  test("fileExtension is lower-case and ignores leading dots", () => {
    assert.equal(fileExtension("A.MP4"), "mp4");
    assert.equal(fileExtension(".bashrc"), "");
  });

  test("formatClock", () => {
    assert.equal(formatClock(3.008), "0:03.01");
    assert.equal(formatClock(83.5), "1:23.50");
    assert.equal(formatClock(3723.5), "1:02:03.50");
    assert.equal(formatClock(59.999), "1:00.00");
  });

  test("summarizeFailure prefers error lines", () => {
    const log = ["frame=1", "Could not find tag for codec vp8 in stream #0", "Conversion failed!"];
    assert.equal(summarizeFailure(log), "Could not find tag for codec vp8 in stream #0\nConversion failed!");
    assert.equal(summarizeFailure(["a", "b"]), "a\nb");
  });
});
