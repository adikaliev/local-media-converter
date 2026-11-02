// Zero-dependency static server for local development and the end-to-end tests.
// Like GitHub Pages, it sends no special headers (no COOP/COEP), so local runs behave like production.
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const envFile = join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides variables already set
const port = Number(process.env.PORT) || 8000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".webm": "video/webm",
  ".mp4": "video/mp4"
};

async function resolveFile(urlPath) {
  const pathname = decodeURIComponent(new URL(urlPath, "http://localhost").pathname);
  // Never serve dotfiles such as .env or .git.
  if (pathname.split("/").some((segment) => segment.startsWith("."))) return null;
  const filePath = resolve(root, `.${pathname}`);
  if (filePath !== root && !filePath.startsWith(root + sep)) return null;
  return (await stat(filePath)).isDirectory() ? join(filePath, "index.html") : filePath;
}

createServer(async (request, response) => {
  try {
    const filePath = await resolveFile(request.url);
    if (!filePath) throw new Error("forbidden");
    const body = await readFile(filePath);
    const type = TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Media Converter running at http://127.0.0.1:${port}/`);
});
