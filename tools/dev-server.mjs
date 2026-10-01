#!/usr/bin/env node
/* Local development server for the whole site + the content API.
 *
 *   node tools/dev-server.mjs            → http://localhost:8080  (local JSON store)
 *   CMS_DRIVER=supabase node tools/dev-server.mjs                  → your real Supabase project
 *
 * It mounts the exact same handler modules that /api/*.mjs uses on Vercel, so the
 * admin dashboard, auth, validation, uploads and public feeds behave identically.
 * This file is a development tool: Vercel never runs it.
 */

import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

process.env.CMS_DRIVER ??= "local";
process.env.CMS_ALLOW_LOCAL_DRIVER ??= "1";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
};

const NEVER_SERVE = ["/.git", "/.cms-data", "/node_modules", "/.env", "/tools/"];

const { handleCms, handlePublic, handleMedia } = await import(path.join(ROOT, "api/_lib/router.mjs"));

const routes = [
  ["/api/cms", handleCms],
  ["/api/public", handlePublic],
  ["/api/media", handleMedia],
];

const serveStatic = async (req, res, pathname) => {
  if (NEVER_SERVE.some((prefix) => pathname.startsWith(prefix))) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  let target = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      target = path.join(target, "index.html");
    }
  } catch {
    // Extensionless path: /notices -> notices.html, matching the production URL shape.
    if (!path.extname(target)) target = `${target}.html`;
  }
  try {
    const file = await fs.readFile(target);
    const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(file);
  } catch {
    const fallback = path.join(ROOT, "404.html");
    try {
      const body = await fs.readFile(fallback);
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404");
    }
  }
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  for (const [prefix, handler] of routes) {
    if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
      try {
        await handler(req, res);
      } catch (error) {
        console.error("[dev] handler error", error);
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "server_error", message: String(error?.message || error) }));
      }
      return;
    }
  }
  if (url.pathname.startsWith("/api/")) {
    // On Vercel every /api path is a function; nothing under /api is a static file.
    // Refuse the same way here so /api/_lib/*.mjs can never be read as text.
    res.writeHead(405, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "not_a_route", message: "This API module is not a public route." }));
    return;
  }
  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  const driver = process.env.CMS_DRIVER;
  console.log(`\n  Rajapur Adarsha High School — dev server`);
  console.log(`  site   http://localhost:${PORT}/`);
  console.log(`  admin  http://localhost:${PORT}/admin/`);
  console.log(`  store  ${driver === "local" ? "local JSON (.cms-data/db.json)" : "Supabase"}\n`);
});
