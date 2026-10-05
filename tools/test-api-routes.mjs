#!/usr/bin/env node
/* Every URL the browser is told to request must be answered by a deployed function.
 *
 * Vercel derives its API routes from the files under api/: a top-level api/media.mjs
 * answers /api/media and nothing deeper, while a folder catch-all api/cms/[...path].mjs
 * answers /api/cms/<one-or-more segments>. A URL outside that table never reaches any
 * code — it 404s as a platform miss with an HTML body, which the dashboard reports as
 * "অনুরোধ ব্যর্থ (HTTP 404)" and an <img> reports as a blank tile. So actions ride on
 * ?action= and storage keys on ?path=, and each group's URL keeps exactly the depth its
 * own file provides.
 *
 * Counting segments is not enough, and it has already been fooled twice: /api/media
 * looks legal at a glance, but it only 404s or works depending on whether the media
 * entry file sits at api/media.mjs or inside api/media/. So the check below reads the
 * real directory layout and matches each URL against it, the way Vercel does.
 *
 *   cd tools && node test-api-routes.mjs
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = 8600 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, pass: false, detail: error?.message || String(error) });
    console.log(` FAIL  ${name} — ${error?.message || error}`);
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** How many path segments does this URL put after /api? (Vercel allows at most 2: group + one.) */
const depthAfterApi = (url) => {
  const pathname = String(url).split("?")[0];
  return pathname.split("/").filter(Boolean).slice(1).length;
};

/* ------------------------------------------------------------------ static rule */

const jar = { cookie: "", csrf: "" };
const remember = (response) => {
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";");
    const [name] = pair.split("=");
    if (name === "rahs_csrf") jar.csrf = pair.split("=")[1] ?? "";
    jar.cookie = [jar.cookie.split("; ").filter((c) => c && !c.startsWith(`${name}=`)), pair].filter(Boolean).join("; ");
  }
};
const call = async (pathname, options = {}) => {
  const headers = { origin: BASE, cookie: jar.cookie, ...(options.headers || {}) };
  if (["POST", "PATCH", "DELETE"].includes(options.method)) headers["x-csrf-token"] = jar.csrf;
  const response = await fetch(`${BASE}${pathname}`, { ...options, headers });
  remember(response);
  const json = await response.json().catch(() => null);
  return { status: response.status, json, response };
};

const collectFrontendUrls = async (file, { relativeTo = null } = {}) => {
  const source = await fs.readFile(path.join(ROOT, file), "utf8");
  const found = new Set();
  // api("…"), api(`…`), uploadFiles("…"), fetch(`/api/…`), fetchJson("…")
  const patterns = [/api\(\s*["`]([^"`]+)["`]/g, /uploadFiles\(\s*["`]([^"`]+)["`]/g, /fetch\(\s*[`"]\/api([^`"]*)[`"]/g, /fetchJson\(\s*[`"]([^`"]+)[`"]/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      let url = match[1].replace(/\$\{[^}]*\}/g, "sample");
      if (pattern.source.startsWith("/fetch")) url = "/api" + url;
      else if (!url.startsWith("/api")) url = relativeTo ? `${relativeTo}${url.replace(/^\//, "")}` : url;
      found.add(url);
    }
  }
  return [...found];
};

console.log("\n— every frontend URL is one segment deep —");
const collected = {
  "admin/admin.js": await collectFrontendUrls("admin/admin.js"),
  "assets/js/site-content.js": await collectFrontendUrls("assets/js/site-content.js", { relativeTo: "/api/public/" }),
};
await check("the admin dashboard only calls /api/<group>/<one segment>", () => {
  assert(collected["admin/admin.js"].length >= 15, `only found ${collected["admin/admin.js"].length} call sites`);
  const deep = collected["admin/admin.js"].filter((url) => url.startsWith("/api") && depthAfterApi(url) > 2);
  assert(deep.length === 0, `too deep: ${deep.join(", ")}`);
  const relative = collected["admin/admin.js"].filter((url) => !url.startsWith("/api") && depthAfterApi(`/api/cms${url}`) > 2);
  assert(relative.length === 0, `too deep: ${relative.join(", ")}`);
});
await check("the public renderer only calls /api/<group>/<one segment>", () => {
  const urls = collected["assets/js/site-content.js"];
  assert(urls.length >= 3, `only found ${urls.length} feeds`);
  const deep = urls.filter((url) => depthAfterApi(url) > 2);
  assert(deep.length === 0, `too deep: ${deep.join(", ")}`);
  assert(urls.length >= 2, "no API calls found in site-content.js");
});
await check("paging rides on the query string, so it needs no new route at all", () => {
  const urls = collected["assets/js/site-content.js"];
  const read = new Set(["limit", "offset", "albums", "per_album"]);
  for (const url of urls) {
    const [pathname, search] = String(url).split("?");
    assert(pathname.split("/").filter(Boolean).length === 3, `${url} is deeper than /api/<group>/<feed> — Vercel would not answer it`);
    for (const pair of (search ?? "").split("&").filter(Boolean)) {
      const [name, value] = pair.split("=");
      assert(read.has(name), `${url} asks for “${name}”, which the public router does not read`);
      // The collector replaces ${…} with "sample", so a value is only missing when the
      // client really left it out.
      assert(value && value.length > 0, `${url} sends an empty ${name}`);
    }
  }
});
await check("mediaUrl() puts the storage key in the query string", async () => {
  const { mediaUrl, thumbTransform } = await import("file://" + path.join(ROOT, "api/_lib/media.mjs"));
  const key = "images/2026-10/2f2a1b6c-0000-4000-8000-abcdefabcdef.webp";
  const plain = mediaUrl(key);
  assert(plain.startsWith("/api/media?path="), plain);
  assert(depthAfterApi(plain) === 1, `media url is ${depthAfterApi(plain)} segments deep`);
  assert(new URLSearchParams(plain.split("?")[1]).get("path") === key, "the path must round-trip unchanged");
  const thumb = mediaUrl(key, thumbTransform());
  const params = new URLSearchParams(thumb.split("?")[1]);
  assert(params.get("path") === key && Number(params.get("w")) > 0, thumb);
  assert(mediaUrl(null) === null, "no file must produce no url");
});

/* ------------------------------------------------- the real Vercel route table */

/** The function files Vercel would deploy, relative to api/. A leading-underscore
 *  folder (api/_lib) is shared code and never a route. */
const entryFiles = await (async () => {
  const found = [];
  const walk = async (dir, prefix = "") => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith("_") && !entry.name.startsWith(".")) await walk(path.join(dir, entry.name), rel);
      } else if (/\.(mjs|js)$/.test(entry.name)) found.push(rel);
    }
  };
  await walk(path.join(ROOT, "api"));
  return found.sort();
})();

/** The URL region one deployed file answers, per Vercel's file routing. */
const routeOf = (rel) => {
  const parts = rel.replace(/\.(mjs|js)$/, "").split("/");
  const catchAll = parts.at(-1).startsWith("[...");
  const own = catchAll ? parts.slice(0, -1) : parts; // the folder the file stands in
  return {
    file: rel,
    prefix: own.join("/"),
    depth: own.length,
    // /api/cms/<one or more> for a catch-all; exactly its own path for a plain file.
    min: catchAll ? own.length + 1 : own.length,
    max: catchAll ? Infinity : own.length,
  };
};

const routes = entryFiles.map(routeOf);

const segmentsAfterApi = (url) => String(url).split("?")[0].split("/").filter(Boolean).slice(1);

/** Which deployed file answers this URL, if any. */
const servedBy = (url) => {
  const parts = segmentsAfterApi(url);
  if (!parts.length) return null;
  const hit = routes.find((route) => route.prefix === parts.slice(0, route.depth).join("/") && parts.length >= route.min && parts.length <= route.max);
  return hit ? hit.file : null;
};

await check("every frontend URL is matched by a deployed function file under api/", async () => {
  const { mediaUrl } = await import("file://" + path.join(ROOT, "api/_lib/media.mjs"));
  const key = "images/2026-10/2f2a1b6c-0000-4000-8000-abcdefabcdef.webp";
  const urls = [
    ...collected["admin/admin.js"].map((url) => (url.startsWith("/api") ? url : `/api/cms${url.startsWith("/") ? "" : "/"}${url}`)),
    ...collected["assets/js/site-content.js"],
    mediaUrl(key),
    mediaUrl(key, { width: 800, height: 600, quality: 72 }),
  ];
  assert(urls.length >= 20, `only ${urls.length} urls to match`);
  const lost = urls.filter((url) => !servedBy(url));
  assert(
    lost.length === 0,
    `${lost.join(", ")} → no file in ${JSON.stringify(entryFiles)} answers that depth; ` +
      `move the entry file or shorten the url (Vercel maps api/x.mjs to /api/x only, api/x/[...path].mjs to /api/x/<segment+>)`,
  );
});
await check("the media route is a top-level function, so /api/media?path=… resolves", () => {
  const depth = segmentsAfterApi("/api/media?path=x").length;
  assert(depth === 1, `media url is ${depth} segments deep`);
  assert(entryFiles.includes("media.mjs"), `api/ holds ${JSON.stringify(entryFiles)} — /api/media needs api/media.mjs, not a media/ folder`);
  assert(servedBy("/api/media?path=x") === "media.mjs", String(servedBy("/api/media?path=x")));
  assert(servedBy("/api/cms/notices") === "cms/[...path].mjs", String(servedBy("/api/cms/notices")));
  assert(!servedBy("/api/media/images/2026-10/x.jpg"), "a key in the path is deeper than api/media.mjs answers — that shape must not be minted");
});

/* ---------------------------------------------------------------- end to end */

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rahs-routes-"));
const server = spawn(process.execPath, [path.join(ROOT, "tools/dev-server.mjs")], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    CMS_DRIVER: "local",
    CMS_ALLOW_LOCAL_DRIVER: "1",
    CMS_ALLOW_SETUP: "1",
    CMS_LOCAL_DIR: tempDir,
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let log = "";
server.stderr.on("data", (chunk) => (log += chunk));

const waitFor = async (predicate, tries = 60) => {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

let noticeId = null;
let albumId = null;
let photoId = null;
let uploadedUrl = null;

try {
  assert(
    await waitFor(async () => {
      try {
        return (await fetch(`${BASE}/api/public/health`)).ok;
      } catch {
        return false;
      }
    }),
    `dev server did not start: ${log.slice(-400)}`,
  );

  const setup = await call("/api/cms/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ full_name: "রাউট পরীক্ষক", email: "routes@school.edu", password: "routing-check-2026" }),
  });
  assert(setup.status === 201, `setup failed: ${setup.status} ${JSON.stringify(setup.json)}`);

  console.log("\n— notice lifecycle through ?action= —");
  const created = await call("/api/cms/notices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "রুটিং যাচাইয়ের নোটিশ", body: "এটি শুধু API পাথ পরীক্ষার জন্য।", published_at: "2026-10-03", status: "draft" }),
  });
  await check("a draft notice can be created", () => {
    assert(created.status === 201 && created.json.item?.id, JSON.stringify(created.json));
    noticeId = created.json.item.id;
  });

  const beforePublish = await call("/api/public/notices");
  await check("the draft is not public yet", () => {
    assert(beforePublish.json.notices.every((row) => row.id !== noticeId), "draft leaked to the public feed");
  });

  await check("publishing through /api/cms/notices?id=…&action=publish succeeds", async () => {
    const response = await call(`/api/cms/notices?id=${encodeURIComponent(noticeId)}&action=publish`, { method: "POST" });
    assert(response.status === 200, `${response.status} ${JSON.stringify(response.json)} log=${log.slice(-300)}`);
    assert(response.json.item.status === "published", JSON.stringify(response.json.item));
  });

  await check("the published notice is readable by the public feed", async () => {
    const feed = await call("/api/public/notices");
    const row = feed.json.notices.find((candidate) => candidate.id === noticeId);
    assert(row, `missing from feed: ${JSON.stringify(feed.json.notices).slice(0, 200)}`);
    assert(row.title === "রুটিং যাচাইয়ের নোটিশ", row.title);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(row.date), `date ${row.date}`);
    assert(typeof row.date_label === "string" && row.date_label.length > 0, "no Bengali date label");
  });

  await check("unpublish and republish both work through the same route", async () => {
    const off = await call(`/api/cms/notices?id=${encodeURIComponent(noticeId)}&action=unpublish`, { method: "POST" });
    assert(off.status === 200 && off.json.item.status === "unpublished", JSON.stringify(off.json));
    const feed = await call("/api/public/notices");
    assert(feed.json.notices.every((row) => row.id !== noticeId), "unpublished notice still public");
    const on = await call(`/api/cms/notices?id=${encodeURIComponent(noticeId)}&action=publish`, { method: "POST" });
    assert(on.status === 200, JSON.stringify(on.json));
  });

  await check("the older /resource/action form still resolves (no client is stranded)", async () => {
    const legacy = await call(`/api/cms/notices/unpublish?id=${encodeURIComponent(noticeId)}`, { method: "POST" });
    assert(legacy.status === 200 && legacy.json.item.status === "unpublished", JSON.stringify(legacy.json));
    const back = await call(`/api/cms/notices?id=${encodeURIComponent(noticeId)}&action=publish`, { method: "POST" });
    assert(back.status === 200, JSON.stringify(back.json));
  });

  console.log("\n— uploads, photos and media through the single-segment form —");
  const album = await call("/api/cms/albums", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "রুটিং পরীক্ষার অ্যালবাম", category: "campus", published_at: "2026-10-03", status: "draft" }),
  });
  await check("an album can be created", () => {
    assert(album.status === 201 && album.json.item?.id, JSON.stringify(album.json));
    albumId = album.json.item.id;
  });

  await check("a photo uploads to /api/cms/photos?action=upload", async () => {
    const bytes = await fs.readFile(path.join(ROOT, "assets/img/campus-hero.webp"));
    const form = new FormData();
    form.set("album_id", albumId);
    form.set("alt_text", "প্রধান বিদ্যালয় ভবন");
    form.set("files", new Blob([bytes], { type: "image/webp" }), "campus-hero.webp");
    const response = await fetch(`${BASE}/api/cms/photos?action=upload`, {
      method: "POST",
      headers: { origin: BASE, cookie: jar.cookie, "x-csrf-token": jar.csrf },
      body: form,
    });
    remember(response);
    const payload = await response.json();
    assert(response.status === 201, `${response.status} ${JSON.stringify(payload)} log=${log.slice(-300)}`);
    assert(payload.photos.length === 1, JSON.stringify(payload).slice(0, 200));
    photoId = payload.photos[0].id;
    uploadedUrl = payload.photos[0].url;
  });

  await check("the returned media URL is one segment deep and serves the bytes", async () => {
    assert(uploadedUrl.startsWith("/api/media?path="), uploadedUrl);
    assert(depthAfterApi(uploadedUrl) === 1, `depth ${depthAfterApi(uploadedUrl)}`);
    const draft = await fetch(`${BASE}${uploadedUrl}`);
    assert(draft.status === 403, `an unpublished photo must not be world-readable, got ${draft.status}`);
    const asAdmin = await fetch(`${BASE}${uploadedUrl}`, { headers: { cookie: jar.cookie } });
    assert(asAdmin.status === 200, `admin fetch got ${asAdmin.status}`);
    assert(asAdmin.headers.get("content-type")?.includes("image/"), asAdmin.headers.get("content-type"));
  });

  await check("photo caption and order work through ?action=", async () => {
    const updated = await call(`/api/cms/photos?action=update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: photoId, caption: "নতুন ক্যাপশন", alt_text: "ভবন ও মাঠ" }),
    });
    assert(updated.status === 200 && updated.json.photo.caption === "নতুন ক্যাপশন", JSON.stringify(updated.json));
    const moved = await call(`/api/cms/photos?action=move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: photoId, direction: "up" }),
    });
    assert(moved.status === 200, JSON.stringify(moved.json));
  });

  await check("publishing the album brings the photo to the public feed and its media is then public", async () => {
    const published = await call(`/api/cms/albums?id=${encodeURIComponent(albumId)}&action=publish`, { method: "POST" });
    assert(published.status === 200, `${published.status} ${JSON.stringify(published.json)} log=${log.slice(-400)}`);
    const gallery = await call("/api/public/gallery?albums=6&per_album=4");
    const albumRow = gallery.json.albums.find((row) => row.id === albumId);
    assert(albumRow && albumRow.photos.length === 1, JSON.stringify(gallery.json).slice(0, 300));
    const photo = albumRow.photos[0];
    assert(String(photo.thumb).startsWith("/api/media?path="), `thumb url ${photo.thumb}`);
    const open = await fetch(`${BASE}${photo.thumb}`);
    assert(open.status === 200, `public thumb got ${open.status}`);
  });

  await check("trash, restore and purge of a notice all answer on the query form", async () => {
    const trashed = await call(`/api/cms/notices?id=${encodeURIComponent(noticeId)}&action=trash`, { method: "POST" });
    assert(trashed.status === 200, JSON.stringify(trashed.json));
    const hidden = await call("/api/public/notices");
    assert(hidden.json.notices.every((row) => row.id !== noticeId), "trashed notice still public");
    const restored = await call(`/api/cms/notices?id=${encodeURIComponent(noticeId)}&action=restore`, { method: "POST" });
    assert(restored.status === 200, JSON.stringify(restored.json));
    const purged = await call(`/api/cms/notices?id=${encodeURIComponent(noticeId)}&action=purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    assert(purged.status === 200, JSON.stringify(purged.json));
  });

  await check("no request in this run produced a non-JSON 404", () => {
    assert(!/Cannot read|Unexpected token/i.test(log), log.slice(-300));
  });
} catch (error) {
  results.push({ name: "harness", pass: false, detail: error?.stack || String(error) });
  console.error(error);
} finally {
  server.kill("SIGTERM");
  await fs.rm(tempDir, { recursive: true, force: true });
}

const failed = results.filter((row) => !row.pass);
if (failed.length && log) console.log("\n— server stderr tail —\n" + log.slice(-1200));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nfailures:\n" + failed.map((row) => `  ✗ ${row.name} — ${row.detail}`).join("\n"));
  process.exitCode = 1;
}
