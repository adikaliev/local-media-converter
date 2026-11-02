// Prints the size and SHA-384 hash of each URL, for updating ASSETS in js/ffmpeg-client.js.
// Usage: npm run hash -- <url> [<url> ...]
import { createHash } from "node:crypto";

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("Usage: npm run hash -- <url> [<url> ...]");
  process.exit(1);
}

for (const url of urls) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  console.log(`${url}\n  size:   ${bytes.length}\n  sha384: ${createHash("sha384").update(bytes).digest("base64")}`);
}
