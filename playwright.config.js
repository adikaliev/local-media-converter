import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "tests/e2e",
  // Conversions run in single-threaded WebAssembly and the first run downloads FFmpeg from the CDN.
  timeout: 180_000,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${PORT}`
  },
  webServer: {
    command: "node scripts/serve.mjs",
    url: `http://127.0.0.1:${PORT}/`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI
  }
});
