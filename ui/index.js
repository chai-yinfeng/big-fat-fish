/**
 * Host half of the optional companion UI bundle.
 *
 * The Client half renders the avatar/panel. This half serves the bundled
 * character art so the Client does not need a build step or a remote CDN.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "companion-ui";
export const inject = ["webServer"];

const PREFIX = "/api/companion-ui/assets";
const MIME = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

export function apply(ctx) {
  const root = fileURLToPath(new URL("./assets/", import.meta.url));
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: PREFIX,
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const url = new URL(req.url ?? PREFIX, "http://127.0.0.1");
      const relative = decodeURIComponent(url.pathname.slice(PREFIX.length)).replace(/^\/+/, "");
      const file = normalize(join(root, relative));
      if (!file.startsWith(root)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      try {
        const info = await stat(file);
        if (!info.isFile()) throw new Error("not a file");
        res.statusCode = 200;
        res.setHeader("content-type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
        res.setHeader("content-length", String(info.size));
        res.setHeader("cache-control", "public, max-age=3600");
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        createReadStream(file).pipe(res);
      } catch {
        res.statusCode = 404;
        res.end();
      }
    },
  }));
}
