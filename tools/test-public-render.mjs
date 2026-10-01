#!/usr/bin/env node
/* Does the public site really show published content — and stay untouched when
 * there is none? This test loads the real HTML files, runs the real site scripts
 * (assets/js/site-content.js + assets/js/main.js) in jsdom against the real API,
 * then asserts on the resulting DOM.
 *
 *   cd tools && npm install && npm run test:public
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { JSDOM } from "jsdom";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = 8200 + Math.floor(Math.random() * 60);
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

const start = async (dir, overrides = {}) => {
  const server = spawn(process.execPath, [path.join(ROOT, "tools/dev-server.mjs")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      CMS_DRIVER: "local",
      CMS_ALLOW_LOCAL_DRIVER: "1",
      CMS_ALLOW_SETUP: "1",
      CMS_LOCAL_DIR: dir,
      ...overrides,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  server.stderr.on("data", (chunk) => (log += chunk));
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${BASE}/api/public/health`)).ok) return { server, log: () => log };
    } catch {
      /* wait */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("server did not start: " + log);
};

const call = async (pathname, options = {}, jar = {}) => {
  const headers = { origin: BASE, ...options.headers };
  if (options.body && !(options.body instanceof FormData)) headers["content-type"] = "application/json";
  // A browser sends the session cookie and its CSRF companion together.
  const jarCookies = [jar.cookie, jar.csrf ? `rahs_csrf=${jar.csrf}` : null].filter(Boolean);
  if (jarCookies.length) headers.cookie = jarCookies.join("; ");
  if (jar.csrf && ["POST", "PATCH", "DELETE"].includes(options.method)) headers["x-csrf-token"] = jar.csrf;
  const response = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers,
    ...(options.body && !(options.body instanceof FormData) ? { body: JSON.stringify(options.body) } : {}),
  });
  for (const value of response.headers.getSetCookie?.() ?? []) {
    const [pair] = value.split(";");
    const [name, ...rest] = pair.split("=");
    if (name === "rahs_csrf") jar.csrf = rest.join("=");
    else jar.cookie = pair;
  }
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
};

const render = async (page, { scripts = true } = {}) => {
  const html = await (await fetch(`${BASE}/${page}`)).text();
  const dom = new JSDOM(html, { url: `${BASE}/${page}`, runScripts: scripts ? "outside-only" : undefined, pretendToBeVisual: true });
  dom.window.fetch = (input, init) => fetch(new URL(input, BASE), init);
  dom.window.CustomEvent = dom.window.CustomEvent || Event;
  if (scripts) {
    const siteContent = await fs.readFile(path.join(ROOT, "assets/js/site-content.js"), "utf8");
    const main = await fs.readFile(path.join(ROOT, "assets/js/main.js"), "utf8");
    dom.window.eval(siteContent);
    dom.window.eval(main);
    for (let tick = 0; tick < 40; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (dom.window.document.documentElement.classList.contains("cms-ready")) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return dom;
};

const tempUnconfigured = await fs.mkdtemp(path.join(os.tmpdir(), "rahs-unconfigured-"));
const tempSeeded = await fs.mkdtemp(path.join(os.tmpdir(), "rahs-seeded-"));
const tempEmpty = await fs.mkdtemp(path.join(os.tmpdir(), "rahs-empty-"));

let seeded = null;
try {
  /* -------------------------------------------------- seed real-shaped content */
  seeded = await start(tempSeeded);
  const jar = {};
  await call("/api/cms/setup", { method: "POST", body: { email: "teacher@school.edu", full_name: "শিক্ষক", password: "bidyalaya-2026" } }, jar);
  const notice = await call(
    "/api/cms/notices",
    {
      method: "POST",
      body: {
        title: "২০ অক্টোবর ২০২৬ থেকে অর্ধ-বার্ষিক পরীক্ষা",
        body: "সকল শ্রেণির শিক্ষার্থীদের নির্ধারিত সময়ে উপস্থিত হতে বলা হয়েছে।\n\nঅ্যাডমিট কার্ড বিতরণ করা হবে।",
        audience: "সকল শ্রেণি",
        notice_type: "exam",
        importance: "urgent",
        published_at: "2026-10-15",
        status: "published",
      },
    },
    jar,
  );
  assert(notice.status === 201, JSON.stringify(notice.json));
  await call("/api/cms/exams", {
    method: "POST",
    body: { exam_name: "অর্ধ-বার্ষিক পরীক্ষা ২০২৬", class_name: "নবম", subject: "গণিত", exam_date: "2026-10-20", start_time: "10:00", room: "২য় তলা, কক্ষ ৫", published_at: "2026-10-15", status: "published" },
  }, jar);
  await call("/api/cms/routines", {
    method: "POST",
    body: { title: "শীতকালীন ক্লাসের সময়সূচি", routine_type: "শ্রেণি রুটিন", event_date: "2026-11-01", start_time: "08:30", description: "শীতকালে সকাল ৮:৩০ থেকে ক্লাস শুরু হবে।", published_at: "2026-10-15", status: "published" },
  }, jar);
  const album = await call("/api/cms/albums", { method: "POST", body: { title: "শিক্ষা সফর ২০২৬", category: "tours", album_date: "2026-09-28", description: "ষাট গম্বুজ পরিদর্শন।", published_at: "2026-10-15", status: "draft" } }, jar);
  const form = new FormData();
  form.set("album_id", album.json.item.id);
  form.append("files", new Blob([await fs.readFile(path.join(ROOT, "assets/img/campus-hero.webp"))], { type: "image/webp" }), "hero.webp");
  form.append("files", new Blob([await fs.readFile(path.join(ROOT, "assets/img/football-match.webp"))], { type: "image/webp" }), "match.webp");
  const uploaded = await call("/api/cms/photos/upload", { method: "POST", body: form }, jar);
  assert(uploaded.json.photos.length === 2, JSON.stringify(uploaded.json));
  await call(`/api/cms/albums/publish?id=${album.json.item.id}`, { method: "POST" }, jar);

  console.log("\n— notices page —");
  const noticesDom = await render("notices.html");
  const noticesDoc = noticesDom.window.document;
  await check("published notice replaces the static list, in the existing card markup", () => {
    const cards = noticesDoc.querySelectorAll('[data-cms="notices"] .notice-card');
    assert(cards.length === 1, `cards ${cards.length}`);
    assert(cards[0].querySelector("h3").textContent.includes("অর্ধ-বার্ষিক পরীক্ষা"), cards[0].innerHTML.slice(0, 120));
    assert(cards[0].classList.contains("primary-notice"), "urgent notice should use the featured card style");
    assert(cards[0].querySelector(".meta-row .tag"), "no tag row");
    assert(cards[0].querySelector(".small-copy").textContent.includes("অ্যাডমিট"), "body paragraph missing");
    assert(cards[0].querySelectorAll(".notice-details span").length === 2, "detail line wrong");
    assert(/অক্টোবর ২০২৬/.test(cards[0].textContent), "no bengali date");
  });
  await check("injected cards use only classes that already exist in style.css", () => {
    const card = noticesDoc.querySelector('[data-cms="notices"] .notice-card');
    const classes = new Set(["notice-card", "primary-notice"]);
    card.querySelectorAll("*").forEach((node) => node.classList.forEach((name) => classes.add(name)));
    classes.delete("sr-only");
    return checkClassesAgainstStylesheet([...classes]);
  });
  await check("exam routine section becomes visible with the published row", () => {
    const section = noticesDoc.getElementById("exam-routines");
    assert(section && section.hidden === false, "still hidden");
    const cards = section.querySelectorAll(".notice-card");
    assert(cards.length === 1, `cards ${cards.length}`);
    assert(cards[0].querySelector("h3").textContent === "অর্ধ-বার্ষিক পরীক্ষা ২০২৬", cards[0].textContent.slice(0, 80));
    const tags = [...cards[0].querySelectorAll(".tag")].map((tag) => tag.textContent);
    assert(tags.includes("নবম") && tags.includes("গণিত"), tags.join("|"));
    assert(/10:00/.test(cards[0].textContent), "time missing");
    assert(/কক্ষ ৫/.test(cards[0].textContent), "room missing");
  });
  await check("other routine section shows the schedule with its type", () => {
    const section = noticesDoc.getElementById("school-routines");
    assert(section.hidden === false, "still hidden");
    const card = section.querySelector(".notice-card");
    assert(card.querySelector("h3").textContent === "শীতকালীন ক্লাসের সময়সূচি", card.textContent.slice(0, 60));
    assert(card.querySelector(".tag").textContent === "শ্রেণি রুটিন", "type tag wrong");
    assert(/08:30/.test(card.textContent), "start time missing");
  });
  await check("unpublished content never reaches the page", async () => {
    const draft = await call("/api/cms/notices", { method: "POST", body: { title: "গোপন খসড়া নোটিশ", body: "প্রকাশযোগ্য নয়", published_at: "2026-10-20", status: "draft" } }, jar);
    assert(draft.status === 201, JSON.stringify(draft.json));
    const dom = await render("notices.html");
    assert(!dom.window.document.body.textContent.includes("গোপন খসড়া"), "draft leaked to the public page");
  });
  await check("content is inserted as text, so markup cannot execute", async () => {
    await call("/api/cms/notices", {
      method: "POST",
      body: { title: "<img src=x onerror=window.__pwned=1>", body: "<script>window.__pwned=2</script>", published_at: "2026-10-21", status: "published" },
    }, jar);
    const dom = await render("notices.html");
    assert(dom.window.__pwned === undefined, "injected script ran");
    const card = [...dom.window.document.querySelectorAll('[data-cms="notices"] .notice-card h3')].find((node) => node.textContent.includes("onerror"));
    assert(card, "title not shown as text");
    assert(card.querySelector("img") === null, "an <img> element was created from stored text");
  });

  console.log("\n— homepage —");
  const homeDom = await render("index.html");
  const homeDoc = homeDom.window.document;
  await check("latest published notice drives the home notice strip", async () => {
    const feed = (await call("/api/public/notices")).json;
    const strip = homeDoc.querySelector('[data-cms="home-notice"]');
    assert(strip.querySelector(".home-notice-text").textContent.trim() === feed.notices[0].title, strip.querySelector(".home-notice-text").textContent.slice(0, 80));
    assert(strip.querySelector(".home-notice-text").querySelector("img") === null, "markup injected into the strip");
    const spans = strip.querySelectorAll(".home-notice-meta span").length;
    assert(feed.notices[0].audience ? spans === 2 : spans === 1, `meta spans ${spans}`);
    assert(strip.querySelector(".home-notice-link").getAttribute("href") === "notices.html#official-notices", "the existing link must stay");
  });
  await check("home page hero and approved content are untouched", () => {
    const hero = homeDoc.querySelector(".home-hero");
    assert(hero.querySelector("h1").textContent === "রাজাপুর আদর্শ উচ্চ বিদ্যালয়", "hero title changed");
    assert(hero.querySelector("img").getAttribute("src") === "assets/img/campus-hero.webp", "hero image changed");
    assert(homeDoc.querySelector(".perf-band .perf-value").textContent === "72.00%", "SSC band altered");
    assert(homeDoc.querySelectorAll(".fact-grid .fact").length === 5, "quick facts altered");
    assert(homeDoc.querySelector(".brand-mark img").getAttribute("src") === "file_000000007e208211b50fdcafeeae9f2e.png", "logo changed");
  });
  await check("home photo strip switches to published photos only", () => {
    const strip = homeDoc.querySelector('[data-cms="photo-strip"]');
    const images = strip.querySelectorAll("img");
    assert(images.length === 2, `images ${images.length}`);
    assert([...images].every((image) => image.getAttribute("src").startsWith("/api/media/")), "not from the CMS");
    assert([...images].every((image) => image.getAttribute("loading") === "lazy"), "not lazy loaded");
  });

  console.log("\n— gallery page —");
  const galleryDom = await render("gallery.html");
  const galleryDoc = galleryDom.window.document;
  await check("published photos render in the curated grid structure", () => {
    const items = galleryDoc.querySelectorAll('[data-cms="gallery"] [data-gallery-item]');
    assert(items.length === 2, `items ${items.length}`);
    const first = items[0];
    assert(first.dataset.tags === "tours", `tags ${first.dataset.tags}`);
    const trigger = first.querySelector("[data-gallery-open]");
    assert(trigger.dataset.image.startsWith("/api/media/"), "lightbox source wrong");
    assert(trigger.querySelector("img").alt.length > 3, "missing alt text");
    assert(trigger.querySelector(".gallery-card-caption strong").textContent.length > 3, "missing caption");
  });
  await check("existing category filters apply to CMS photos", () => {
    const status = galleryDoc.getElementById("galleryStatus");
    assert(/২টি ছবি|2টি ছবি/.test(status.textContent), status.textContent);
    galleryDoc.querySelector('[data-filter="tours"]').dispatchEvent(new galleryDom.window.MouseEvent("click", { bubbles: true }));
    assert([...galleryDoc.querySelectorAll("[data-gallery-item]")].filter((item) => !item.hidden).length === 2, "filter mismatch");
    galleryDoc.querySelector('[data-filter="tree"]').dispatchEvent(new galleryDom.window.MouseEvent("click", { bubbles: true }));
    assert([...galleryDoc.querySelectorAll("[data-gallery-item]")].filter((item) => !item.hidden).length === 0, "filter leaked other tags");
  });
  await check("lightbox opens for a CMS photo", () => {
    const trigger = galleryDoc.querySelector('[data-cms="gallery"] [data-gallery-open]');
    trigger.dispatchEvent(new galleryDom.window.MouseEvent("click", { bubbles: true }));
    const image = galleryDoc.getElementById("lightboxImage");
    assert(image.getAttribute("src") === trigger.dataset.image, `lightbox src ${image.getAttribute("src")}`);
    assert(galleryDoc.getElementById("lightboxTitle").textContent.length > 0, "no lightbox title");
  });

  /* --------------------------------------------------- empty CMS, static site */
  seeded.server.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const empty = await start(tempEmpty);
  console.log("\n— with an empty database the site is unchanged —");
  for (const page of ["index.html", "notices.html", "gallery.html"]) {
    await check(`${page} keeps its approved content`, async () => {
      const withoutScripts = await render(page, { scripts: false });
      const withScripts = await render(page);
      const clean = (document) =>
        document
          .querySelector("main")
          .innerHTML.replace(/\s*data-cms="[^"]*"/g, "")
          .replace(/\s*hidden(?=[\s>])/g, "")
          .replace(/(<p class="sr-only" id="galleryStatus"[^>]*>)[\s\S]*?(<\/p>)/, "$1$2");
      assert(clean(withScripts.window.document) === clean(withoutScripts.window.document), "script output differs from the static page");
    });
  }
  await check("hidden routine sections stay hidden with no data", async () => {
    const doc = (await render("notices.html")).window.document;
    assert(doc.getElementById("exam-routines").hidden, "exam section should stay hidden");
    assert(doc.getElementById("school-routines").hidden, "routines section should stay hidden");
  });
  await check("the curated 17-photo gallery stays exactly as authored", async () => {
    const doc = (await render("gallery.html")).window.document;
    const items = doc.querySelectorAll(".gallery-grid [data-gallery-item]");
    assert(items.length === 17, `items ${items.length}`);
    assert(items[0].querySelector("img").getAttribute("src") === "assets/img/campus-hero.webp", "first curated photo changed");
  });
  empty.server.kill("SIGTERM");

  // Exactly the state of a fresh Vercel preview before any Supabase env vars exist:
  // the API refuses, and the website must still look like the approved site.
  console.log("\n— with no database configured, pages are untouched —");
  const broken = await start(tempUnconfigured, { CMS_DRIVER: "supabase", SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" });
  await check("public feeds fail softly and the pages keep their static content", async () => {
    const response = await fetch(`${BASE}/api/public/notices`);
    assert(response.status >= 400, `expected an error status, got ${response.status}`);
    for (const page of ["index.html", "notices.html", "gallery.html"]) {
      const plain = await render(page, { scripts: false });
      const live = await render(page);
      const clean = (document) =>
        document
          .querySelector("main")
          .innerHTML.replace(/\s*data-cms="[^"]*"/g, "")
          .replace(/\s*hidden(?=[\s>])/g, "")
          .replace(/(<p class="sr-only" id="galleryStatus"[^>]*>)[\s\S]*?(<\/p>)/, "$1$2");
      assert(clean(live.window.document) === clean(plain.window.document), `${page} changed with a broken API`);
    }
    const health = await (await fetch(`${BASE}/api/public/health`)).json();
    assert(health.configProblems.length, "health should report the missing config");
  });
  broken.server.kill("SIGTERM");
} catch (error) {
  results.push({ name: "harness", pass: false, detail: error?.stack || String(error) });
  console.error("harness error", error);
} finally {
  seeded?.server.kill("SIGTERM");
  await fs.rm(tempSeeded, { recursive: true, force: true });
  await fs.rm(tempUnconfigured, { recursive: true, force: true });
  await fs.rm(tempEmpty, { recursive: true, force: true });
}

async function checkClassesAgainstStylesheet(classes) {
  const css = await fs.readFile(path.join(ROOT, "assets/css/style.css"), "utf8");
  const missing = classes.filter((name) => !css.includes(`.${name}`));
  assert(missing.length === 0, `classes not in style.css: ${missing.join(", ")}`);
}

const failed = results.filter((row) => !row.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nfailures:\n" + failed.map((row) => `  ✗ ${row.name} — ${row.detail}`).join("\n"));
  process.exitCode = 1;
}
