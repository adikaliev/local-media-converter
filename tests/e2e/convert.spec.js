// End-to-end tests: real page, real ffmpeg.wasm from the CDN, real conversions of a
// 3-second 161x121 VP8/Opus clip (odd size on purpose, to exercise the even-size scaling).
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SAMPLE = fileURLToPath(new URL("../fixtures/sample.webm", import.meta.url));
const ENGINE_TIMEOUT = 120_000;

const ascii = (bytes, start, end) => bytes.toString("latin1", start, end);
const isEbml = (bytes) => bytes.readUInt32BE(0) === 0x1a45dfa3; // Matroska and WebM

// Checks the first bytes of each output container.
const SIGNATURES = {
  mp4: (bytes) => ascii(bytes, 4, 8) === "ftyp",
  m4a: (bytes) => ascii(bytes, 4, 8) === "ftyp",
  mkv: isEbml,
  webm: isEbml,
  avi: (bytes) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 11) === "AVI",
  wav: (bytes) => ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE",
  flac: (bytes) => ascii(bytes, 0, 4) === "fLaC",
  mp3: (bytes) => ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
};

async function openWithSample(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.setInputFiles("#sourceFile", SAMPLE);
  await expect(page.locator("#fileInfo")).toContainText("sample.webm");
  await expect(page.locator("#durationHint")).toContainText("Detected duration: 0:03.01");
  return errors;
}

async function choose(page, { mode = "video", method = "encode", format, start = "", end = "" }) {
  await page.selectOption("#conversionMode", mode);
  await page.selectOption("#methodSelect", method);
  await page.selectOption("#formatSelect", format);
  await page.fill("#startTime", start);
  await page.fill("#endTime", end);
}

async function convert(page, options) {
  await choose(page, options);
  await page.click("#convertButton");
  await expect(page.locator("#statusMessage")).toHaveText(/^Done in/, { timeout: ENGINE_TIMEOUT });
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#downloadLink")]);
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}

test.describe("conversions", () => {
  test.describe.configure({ mode: "serial" });

  let page;
  let pageErrors;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    pageErrors = await openWithSample(page);
    await expect(page.locator("#engineStatus")).toHaveText("FFmpeg engine ready.", { timeout: ENGINE_TIMEOUT });
  });

  test.afterAll(async () => {
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  const cases = [
    { mode: "video", format: "mp4", name: "sample.mp4" },
    { mode: "video", format: "mkv", name: "sample.mkv" },
    { mode: "video", format: "webm", name: "sample-converted.webm" },
    { mode: "video", format: "avi", name: "sample.avi" },
    { mode: "audio", format: "mp3", name: "sample.mp3" },
    { mode: "audio", format: "m4a", name: "sample.m4a" },
    { mode: "audio", format: "wav", name: "sample.wav" },
    { mode: "audio", format: "flac", name: "sample.flac" }
  ];

  for (const { mode, format, name } of cases) {
    test(`re-encodes to ${format}`, async () => {
      const result = await convert(page, { mode, format });
      expect(result.name).toBe(name);
      expect(SIGNATURES[format](result.bytes)).toBe(true);
    });
  }

  test("trims with start and end times", async () => {
    const result = await convert(page, { format: "mp4", start: "0.5", end: "0:02" });
    expect(SIGNATURES.mp4(result.bytes)).toBe(true);
    await expect(page.locator("#ffmpegLog")).toContainText("-ss 0.5 -t 1.5 -i /input/sample.webm");
  });

  test("fast copy keeps the source container", async () => {
    await choose(page, { method: "copy", format: "mkv" });
    await page.selectOption("#methodSelect", "encode");
    await page.selectOption("#methodSelect", "copy");
    await expect(page.locator("#formatSelect")).toHaveValue("source");
    await expect(page.locator("#videoQuality")).toBeDisabled();

    const result = await convert(page, { method: "copy", format: "source", start: "1" });
    expect(result.name).toBe("sample-converted.webm");
    expect(SIGNATURES.webm(result.bytes)).toBe(true);
    await expect(page.locator("#ffmpegLog")).toContainText("-c copy");
  });

  test("explains a fast copy that doesn't fit the container, then recovers", async () => {
    // AVI has no codec tag for the sample's Opus audio.
    await choose(page, { method: "copy", format: "avi" });
    await page.click("#convertButton");
    const status = page.locator("#statusMessage");
    await expect(status).toContainText("Conversion failed", { timeout: ENGINE_TIMEOUT });
    await expect(status).toContainText("Try MKV, or Re-encode");
    await expect(page.locator("#downloadLink")).toBeHidden();

    const result = await convert(page, { format: "mp4" });
    expect(SIGNATURES.mp4(result.bytes)).toBe(true);
  });

  test("rejects an invalid trim range without running FFmpeg", async () => {
    await choose(page, { format: "mp4", start: "2", end: "1" });
    await page.click("#convertButton");
    await expect(page.locator("#statusMessage")).toHaveText("End time must be after the start time.");
    await expect(page.locator("#cancelButton")).toBeHidden();
  });

  test("cancels a running conversion and can convert again", async () => {
    await choose(page, { format: "webm" });
    await page.click("#convertButton");
    await page.click("#cancelButton");
    await expect(page.locator("#statusMessage")).toHaveText("Cancelled.");
    await expect(page.locator("#convertButton")).toBeEnabled();

    const result = await convert(page, { mode: "audio", format: "mp3" });
    expect(SIGNATURES.mp3(result.bytes)).toBe(true);
  });
});

test("page shows the limitations and needs a file before converting", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Good to know" })).toBeVisible();
  await expect(page.locator(".limits")).toContainText("never uploaded");
  await expect(page.locator("#convertButton")).toBeDisabled();
  await expect(page.locator("#downloadLink")).toBeHidden();
});
