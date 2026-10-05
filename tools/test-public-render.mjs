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
import { JSDOM, VirtualConsole } from "jsdom";

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
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (event) => errors.push(String(event?.message || event)));
  virtualConsole.on("error", (...parts) => errors.push(parts.join(" ")));
  const dom = new JSDOM(html, { url: `${BASE}/${page}`, runScripts: scripts ? "outside-only" : undefined, pretendToBeVisual: true, virtualConsole });
  dom.window.addEventListener("error", (event) => errors.push(event.message));
  dom.pageErrors = errors;
  dom.window.fetch = (input, init) => fetch(new URL(input, BASE), init);
  dom.window.CustomEvent = dom.window.CustomEvent || Event;
  if (scripts) {
    const siteContent = await fs.readFile(path.join(ROOT, "assets/js/site-content.js"), "utf8");
    dom.window.eval(siteContent);
    if (scripts !== "cms-only") {
      const main = await fs.readFile(path.join(ROOT, "assets/js/main.js"), "utf8");
      dom.window.eval(main);
    }
    for (let tick = 0; tick < 40; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (dom.window.document.documentElement.classList.contains("cms-ready") || !dom.window.document.querySelector("[data-cms]")) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return dom;
};

/**
 * Renders a real page against a hand-written feed instead of a seeded database, so a page
 * size, a "load older" click and an overlapping second page can be exercised exactly —
 * without publishing a thousand rows to reach a limit. `routes` is keyed by feed name;
 * each entry answers the first request (`?offset` absent or 0) with `first`, and any later
 * request with `next(offset)`.
 */
const renderWithFeed = async (page, routes) => {
  const html = await (await fetch(`${BASE}/${page}`)).text();
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (event) => errors.push(String(event?.message || event)));
  virtualConsole.on("error", (...parts) => errors.push(parts.join(" ")));
  const dom = new JSDOM(html, { url: `${BASE}/${page}`, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  dom.window.fetch = async (input) => {
    const url = new URL(input, BASE);
    const route = routes[url.pathname.split("/").pop()];
    if (!route) return { ok: 404, json: async () => ({ ok: false }) };
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const payload = offset === 0 ? route.first : (await route.next(offset));
    return { ok: true, json: async () => payload };
  };
  dom.window.addEventListener("error", (event) => errors.push(event.message));
  dom.window.eval(await fs.readFile(path.join(ROOT, "assets/js/site-content.js"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 80));
  dom.pageErrors = errors;
  return dom;
};
const emptyFeed = { first: { ok: true, albums: [] } };
const feedNotice = (id, extra = {}) => ({
  id,
  title: `নোটিশ ${id}`,
  body: "পরীক্ষার জন্য নির্ধারিত সময়ে উপস্থিত থাকুন।",
  audience: "নবম শ্রেণি",
  type: "exam",
  importance: "normal",
  date: "2026-10-01",
  date_label: "১ অক্টোবর ২০২৬",
  file: null,
  ...extra,
});
const feedExam = (id, date) => ({
  id,
  exam_name: `পরীক্ষা ${id}`,
  class_name: "নবম",
  subject: "গণিত",
  date,
  date_label: "১৮ নভেম্বর ২০২৬",
  time: "10:00",
  room: "কক্ষ ৫",
  notes: null,
  file: null,
});
const feedRoutine = (id, date) => ({
  id,
  title: `রুটিন ${id}`,
  routine_type: "শ্রেণি রুটিন",
  class_name: "নবম",
  date,
  date_label: date ? "১ ডিসেম্বর ২০২৬" : null,
  start_time: "08:30",
  end_time: "13:00",
  description: "শীতকালীন সময়সূচি।",
  file: null,
});
const recordIds = (list) => [...list.querySelectorAll("[data-cms-record]")].map((node) => node.dataset.cmsRecord);

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

  /* ------------------------------------- a published list keeps what it published */

  console.log("\n— published lists accumulate, and older pages stay reachable —");
  const noticeList = (doc) => doc.querySelector('[data-cms="notices"]');
  await check("every published notice is on the page, newest first, the placeholder superseded", async () => {
    const feed = (await call("/api/public/notices")).json;
    assert(feed.notices.length === 2, `feed has ${feed.notices.length} rows, the test expects 2`);
    const doc = (await render("notices.html")).window.document;
    const cards = [...noticeList(doc).querySelectorAll(".notice-card")];
    assert(cards.length === feed.notices.length, `cards ${cards.length} vs feed ${feed.notices.length}`);
    assert(recordIds(noticeList(doc)).join() === feed.notices.map((row) => row.id).join(), "the page is not the feed, in order");
    assert(cards[0].querySelector("h3").textContent.includes("onerror"), "the newest published notice is not on top");
    assert(!cards.some((card) => card.textContent.includes("মডেল টেস্ট পরীক্ষা শুরু হবে")), "the authored placeholder was left beside the real notices");
    assert(doc.querySelector("#official-notices h2").textContent === "অফিশিয়াল নোটিশ", "the section's own heading moved");
  });
  await check("publishing a third notice removes nothing and adds one card", async () => {
    const before = (await call("/api/public/notices")).json.notices.map((row) => row.id);
    const created = await call("/api/cms/notices", { method: "POST", body: { title: "ছুটির নোটিশ", body: "সকল শ্রেণি বন্ধ থাকবে।", published_at: "2026-10-25", status: "published" } }, jar);
    assert(created.status === 201, JSON.stringify(created.json));
    const doc = (await render("notices.html")).window.document;
    const after = recordIds(noticeList(doc));
    assert(after.length === before.length + 1, `cards went from ${before.length} to ${after.length}`);
    for (const id of before) assert(after.includes(id), `an older published notice (${id}) disappeared`);
    assert(after.includes(created.json.item.id), "the new notice is not on the page");
    assert(new Set(after).size === after.length, "a notice card was duplicated");
  });
  await check("an appended notice keeps its attachment link", async () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"), Buffer.from("%".repeat(120))]);
    const form = new FormData();
    form.set("file", new Blob([pdf], { type: "application/pdf" }), "ছুটির-নোটিশ.pdf");
    const upload = await call("/api/cms/upload", { method: "POST", body: form }, jar);
    assert(upload.status === 201, JSON.stringify(upload.json));
    const created = await call("/api/cms/notices", { method: "POST", body: { title: "নথিসহ নোটিশ", body: "সংযুক্ত নথি দেখুন।", published_at: "2026-10-26", status: "published", file: upload.json.file } }, jar);
    assert(created.status === 201, JSON.stringify(created.json));
    const doc = (await render("notices.html")).window.document;
    const card = [...noticeList(doc).querySelectorAll(".notice-card")].find((node) => node.dataset.cmsRecord === created.json.item.id);
    assert(card, "the newest notice is not on the page");
    const link = card.querySelector("a.text-link");
    assert(link && link.getAttribute("href").startsWith("/api/media?path="), `attachment link wrong: ${link?.getAttribute("href")}`);
    assert(link.hasAttribute("download") && link.rel === "noopener", "the download affordance changed");
    const media = await fetch(`${BASE}${link.getAttribute("href")}`);
    assert(media.status === 200 && media.headers.get("content-type") === "application/pdf", `attachment serves ${media.status}`);
  });
  await check("no control appears while the feed has nothing behind the first page", async () => {
    const doc = (await render("notices.html")).window.document;
    const feed = (await call("/api/public/notices")).json;
    assert(feed.has_more === false && feed.next_offset === null, `feed says has_more ${feed.has_more}`);
    assert(doc.querySelectorAll("[data-cms-more]").length === 0, "a load-more control was built for nothing to load");
  });

  /* -------------------------------------------------- reaching older records */

  await check("the control appears when the feed says older rows exist", async () => {
    const dom = await renderWithFeed("notices.html", {
      notices: {
        first: { ok: true, notices: [feedNotice("n1"), feedNotice("n2")], limit: 2, offset: 0, has_more: true, next_offset: 2 },
      },
    });
    const list = noticeList(dom.window.document);
    const control = list.querySelector("[data-cms-more]");
    assert(control, "no আরও পুরোনো control was built");
    assert(control.textContent === "আরও পুরোনো নোটিশ দেখুন", control.textContent);
    assert(control.tagName === "BUTTON" && control.getAttribute("type") === "button", "the control is not a plain button");
    assert([...control.classList].join(" ") === "btn btn-outline", `control classes: ${control.className}`);
    await checkClassesAgainstStylesheet(["btn", "btn-outline"]);
    assert(recordIds(list).join() === "n1,n2", recordIds(list).join());
    assert(dom.pageErrors.length === 0, dom.pageErrors.join(" | "));
  });
  await check("clicking it adds the older page below the cards already shown", async () => {
    const dom = await renderWithFeed("notices.html", {
      notices: {
        first: { ok: true, notices: [feedNotice("n1"), feedNotice("n2")], limit: 2, offset: 0, has_more: true, next_offset: 2 },
        // The second page deliberately repeats n2: a row that moved between two requests
        // must be skipped, not shown twice.
        next: (offset) => ({ ok: true, notices: [feedNotice("n2"), feedNotice("n3")], limit: 2, offset, has_more: false, next_offset: null }),
      },
    });
    const list = noticeList(dom.window.document);
    list.querySelector("[data-cms-more]").click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert(recordIds(list).join() === "n1,n2,n3", recordIds(list).join());
    assert(list.querySelectorAll(".notice-card").length === 3, "a card was replaced instead of added to");
    assert(list.querySelector("[data-cms-more]") === null, "the control stayed after the last page");
    assert(list.getAttribute("aria-busy") === null, "the list is still marked busy");
    assert(dom.pageErrors.length === 0, dom.pageErrors.join(" | "));
  });
  await check("a second click while a page is loading cannot skip ahead", async () => {
    let requests = 0;
    const dom = await renderWithFeed("notices.html", {
      notices: {
        first: { ok: true, notices: [feedNotice("n1"), feedNotice("n2")], limit: 2, offset: 0, has_more: true, next_offset: 2 },
        next: async (offset) => {
          requests += 1;
          await new Promise((resolve) => setTimeout(resolve, 140));
          return { ok: true, notices: [feedNotice(`n${offset + 1}`), feedNotice(`n${offset + 2}`)], limit: 2, offset, has_more: false, next_offset: null };
        },
      },
    });
    const list = noticeList(dom.window.document);
    const control = list.querySelector("[data-cms-more]");
    control.click();
    control.click();
    control.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert(requests === 1, `${requests} pages were asked for in reply to three clicks`);
    assert(recordIds(list).join() === "n1,n2,n3,n4", recordIds(list).join());
    assert(list.querySelector("[data-cms-more]") === null, "the control survived the last page");
    assert(dom.pageErrors.length === 0, dom.pageErrors.join(" | "));
  });
  await check("running the script again cannot leave a duplicate card behind", async () => {
    const dom = await renderWithFeed("notices.html", {
      notices: {
        first: { ok: true, notices: [feedNotice("n1"), feedNotice("n2")], limit: 2, offset: 0, has_more: true, next_offset: 2 },
        next: (offset) => ({ ok: true, notices: [feedNotice("n3")], limit: 2, offset, has_more: false, next_offset: null }),
      },
    });
    const list = noticeList(dom.window.document);
    list.querySelector("[data-cms-more]").click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert(recordIds(list).join() === "n1,n2,n3", recordIds(list).join());
    dom.window.eval(await fs.readFile(path.join(ROOT, "assets/js/site-content.js"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const ids = recordIds(list);
    assert(ids.join() === "n1,n2", `a re-render produced ${ids.join(",")}`);
    assert(new Set(ids).size === ids.length, "a card was duplicated");
    assert(list.querySelectorAll(".notice-card").length === 2, "a re-render left a stale older page on the list");
    assert(list.querySelector("[data-cms-more]"), "the control vanished, so the older page became unreachable");
  });
  await check("an earlier exam-routine page is added above, in date order", async () => {
    const dom = await renderWithFeed("notices.html", {
      exams: {
        first: { ok: true, exams: [feedExam("e3", "2026-11-20"), feedExam("e4", "2026-11-25")], limit: 2, offset: 0, has_more: true, next_offset: 2 },
        next: (offset) => ({ ok: true, exams: [feedExam("e1", "2026-11-10"), feedExam("e2", "2026-11-15")], limit: 2, offset, has_more: false, next_offset: null }),
      },
    });
    const section = dom.window.document.getElementById("exam-routines");
    const list = section.querySelector('[data-cms="exam-routines"]');
    assert(section.hidden === false, "the exam section stayed hidden with rows to show");
    assert(recordIds(list).join() === "e3,e4", recordIds(list).join());
    const control = list.querySelector("[data-cms-more]");
    assert(control && control.textContent === "আগের রুটিন দেখুন", control?.textContent);
    assert(list.firstElementChild === control, "the earlier-rows control belongs above the cards");
    control.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert(recordIds(list).join() === "e1,e2,e3,e4", recordIds(list).join());
    assert(dom.pageErrors.length === 0, dom.pageErrors.join(" | "));
  });
  await check("older routines are appended below, newest first throughout", async () => {
    const dom = await renderWithFeed("notices.html", {
      routines: {
        first: { ok: true, routines: [feedRoutine("r1", "2026-12-05"), feedRoutine("r2", "2026-12-01")], limit: 2, offset: 0, has_more: true, next_offset: 2 },
        next: (offset) => ({ ok: true, routines: [feedRoutine("r3", "2026-11-20"), feedRoutine("r4", null)], limit: 2, offset, has_more: false, next_offset: null }),
      },
    });
    const list = dom.window.document.querySelector('[data-cms="routines"]');
    assert(list.querySelector("[data-cms-more]").textContent === "আরও পুরোনো রুটিন দেখুন", "wrong label for the routines list");
    list.querySelector("[data-cms-more]").click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert(recordIds(list).join() === "r1,r2,r3,r4", recordIds(list).join());
    const last = list.lastElementChild;
    assert(last.dataset.cmsRecord === "r4" && !last.textContent.includes("১ ডিসেম্বর"), "an undated routine must still sort last, without a date line");
    assert(dom.pageErrors.length === 0, dom.pageErrors.join(" | "));
  });
  await check("a feed that answers nothing leaves the page exactly as authored", async () => {
    const dom = await renderWithFeed("notices.html", {
      notices: { first: { ok: true, notices: [], limit: 20, offset: 0, has_more: false, next_offset: null } },
      exams: { first: { ok: true, exams: [], limit: 200, offset: 0, has_more: false, next_offset: null } },
      routines: { first: { ok: true, routines: [], limit: 40, offset: 0, has_more: false, next_offset: null } },
    });
    const doc = dom.window.document;
    assert(doc.querySelectorAll("[data-cms-record], [data-cms-more]").length === 0, "a card or control was built from an empty page");
    assert(noticeList(doc).querySelector(".notice-card h3").textContent.includes("মডেল টেস্ট পরীক্ষা শুরু হবে"), "the authored zero-state notice was removed");
    assert(doc.getElementById("exam-routines").hidden && doc.getElementById("school-routines").hidden, "an empty routine feed left its section open");
    assert(dom.pageErrors.length === 0, dom.pageErrors.join(" | "));
  });
  await check("the paged lists and the gallery never mix their markers", async () => {
    const dom = await renderWithFeed("notices.html", { notices: { first: { ok: true, notices: [feedNotice("n1")], limit: 1, offset: 0, has_more: false, next_offset: null } } });
    assert(dom.window.document.querySelectorAll("[data-cms-photo]").length === 0, "a gallery tile leaked onto the notices page");
    const galleryPage = (await render("gallery.html")).window.document;
    assert(galleryPage.querySelectorAll("[data-cms-record], [data-cms-more]").length === 0, "a list card leaked into the gallery");
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
  await check("home photo strip keeps its static photos and adds the published ones", () => {
    const strip = homeDoc.querySelector('[data-cms="photo-strip"]');
    const links = [...strip.querySelectorAll("a")];
    const images = links.map((link) => link.querySelector("img"));
    assert(images.length === 6, `images ${images.length}`); // 4 authored + 2 published
    const authored = links.filter((link) => !link.hasAttribute("data-cms-photo"));
    const added = links.filter((link) => link.hasAttribute("data-cms-photo"));
    assert(authored.length === 4 && added.length === 2, `authored ${authored.length}, added ${added.length}`);
    assert(authored[0].querySelector("img").getAttribute("src") === "assets/img/students-program.webp", "the first authored strip photo moved");
    assert(authored.every((link) => !link.getAttribute("src") && !link.dataset.cmsPhoto), "an authored tile was altered");
    assert(added.every((link) => link.querySelector("img").getAttribute("src").startsWith("/api/media?path=")), "not from the CMS");
    assert(added.every((link) => link.querySelector("img").getAttribute("loading") === "lazy"), "added photos are not lazy loaded");
    assert(added.every((link) => link.getAttribute("href") === "gallery.html"), "added link no longer points at the gallery page");
  });

  /** Renders the real gallery page with a chosen feed, so photo counts can be
   *  pinned exactly without disturbing the seeded database. */
  const renderGalleryWith = async (albums) => {
    const html = await (await fetch(`${BASE}/gallery.html`)).text();
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (event) => errors.push(String(event?.message || event)));
    virtualConsole.on("error", (...parts) => errors.push(parts.join(" ")));
    const dom = new JSDOM(html, { url: `${BASE}/gallery.html`, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
    dom.window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, albums }) });
    dom.window.addEventListener("error", (event) => errors.push(event.message));
    dom.window.eval(await fs.readFile(path.join(ROOT, "assets/js/site-content.js"), "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    dom.pageErrors = errors;
    return dom;
  };
  const feedAlbum = (id, title, photos) => ({ id, title, category: "campus", date: "2026-10-01", date_label: "১ অক্টোবর ২০২৬", photo_count: photos.length, photos });
  const feedPhoto = (id) => ({
    id,
    alt: `ক্যাম্পাসের ছবি ${id}`,
    caption: null,
    width: 1200,
    height: 900,
    thumb: `/api/media?path=images%2F2026-10%2F${id}.webp&w=800&h=600&q=72`,
    full: `/api/media?path=images%2F2026-10%2F${id}.webp`,
  });
  const gridItems = (doc) => doc.querySelectorAll('[data-cms="gallery"] [data-gallery-item]');

  console.log("\n— gallery page —");
  const galleryDom = await render("gallery.html");
  const galleryStatic = await render("gallery.html", { scripts: false });
  const galleryDoc = galleryDom.window.document;
  await check("published photos are added after the 17 curated tiles, in the curated markup", () => {
    const items = [...galleryDoc.querySelectorAll('[data-cms="gallery"] [data-gallery-item]')];
    assert(items.length === 19, `items ${items.length}`);
    const curated = items.filter((item) => !item.hasAttribute("data-cms-photo"));
    const added = items.filter((item) => item.hasAttribute("data-cms-photo"));
    assert(curated.length === 17 && added.length === 2, `curated ${curated.length}, added ${added.length}`);
    assert(curated.every((item, index) => item === items[index]), "a published photo was inserted before the curated ones");
    assert(added.every((item) => item.classList.contains("gallery-item")), "added tile does not use the curated tile class");
    assert(added.every((item) => item.querySelector(":scope > button.gallery-card > span.gallery-image-wrap > img")), "added tile does not use the curated tile structure");
    const first = added[0];
    assert(first.dataset.tags === "tours", `tags ${first.dataset.tags}`);
    const trigger = first.querySelector("[data-gallery-open]");
    assert(trigger.dataset.image.startsWith("/api/media?path="), "lightbox source wrong");
    assert(trigger.querySelector("img").getAttribute("src").startsWith("/api/media?path="), "thumbnail source wrong");
    assert(trigger.querySelector("img").alt.length > 3, "missing alt text");
    assert(trigger.querySelector(".gallery-card-caption strong").textContent.length > 3, "missing caption");
  });
  await check("the 17 curated photos keep their exact authored paths", () => {
    const before = galleryStatic.window.document.querySelectorAll(".gallery-grid > [data-gallery-item] img");
    const after = [...galleryDoc.querySelectorAll('[data-cms="gallery"] [data-gallery-item]:not([data-cms-photo]) img')];
    assert(before.length === 17 && after.length === 17, `${before.length} vs ${after.length}`);
    for (let index = 0; index < 17; index += 1) {
      assert(after[index].getAttribute("src") === before[index].getAttribute("src"), `tile ${index} changed src`);
    }
    assert(after[0].getAttribute("src") === "assets/img/campus-hero.webp", "the first curated photo is not campus-hero");
  });
  await check("a second render adds no duplicate tiles and keeps the count at 19", async () => {
    const siteContent = await fs.readFile(path.join(ROOT, "assets/js/site-content.js"), "utf8");
    galleryDom.window.eval(siteContent); // the same page rendered again, e.g. after a refetch
    for (let tick = 0; tick < 40; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (galleryDoc.querySelectorAll('[data-cms="gallery"] [data-cms-photo]').length === 2) break;
    }
    const items = galleryDoc.querySelectorAll('[data-cms="gallery"] [data-gallery-item]');
    const added = galleryDoc.querySelectorAll('[data-cms="gallery"] [data-cms-photo]');
    assert(items.length === 19, `items ${items.length}`);
    assert(added.length === 2, `added tiles ${added.length}`);
    const ids = new Set([...added].map((tile) => tile.dataset.cmsPhoto));
    assert(ids.size === 2, `photo ids reused: ${[...ids].join(",")}`);
    assert(galleryDoc.querySelectorAll('[data-cms="photo-strip"]').length === 0, "the gallery page should not own a strip");
  });
  await check("appended tiles flow inside the existing grid, so mobile cannot overflow", async () => {
    // The two containers are CSS grids whose columns are minmax(0, 1fr), so an extra
    // tile always starts a new row instead of widening the page. Pinned here because
    // the added tiles are the only new DOM this feature puts on a public page.
    const css = await fs.readFile(path.join(ROOT, "assets/css/style.css"), "utf8");
    for (const selector of [".gallery-grid", ".photo-strip"]) {
      const rule = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
      assert(/display:\s*grid/.test(rule) && /minmax\(0,\s*1fr\)/.test(rule), `${selector} is not a fluid grid: ${rule.slice(0, 120)}`);
    }
    const tile = galleryDoc.querySelector('[data-cms="gallery"] [data-cms-photo]');
    assert(tile.parentElement.classList.contains("gallery-grid"), "a published tile landed outside the grid container");
    assert(!tile.getAttribute("style") && !tile.querySelector("img").getAttribute("style"), "an added tile carries inline styles that could override the layout");
    const addedImgs = [...galleryDoc.querySelectorAll('[data-cms="gallery"] [data-cms-photo] img')];
    assert(addedImgs.every((img) => img.getAttribute("width") && img.getAttribute("height")), "added images need intrinsic size to avoid layout shift");
  });
  await check("published tiles bring no class the stylesheet does not already know", () => {
    const tile = galleryDoc.querySelector('[data-cms="gallery"] [data-cms-photo]');
    const classes = new Set(["gallery-item", "gallery-card"]);
    tile.querySelectorAll("*").forEach((node) => node.classList.forEach((name) => classes.add(name)));
    return checkClassesAgainstStylesheet([...classes]);
  });
  await check("no gallery or home script error on the merged page", () => {
    assert(galleryDom.pageErrors.length === 0, galleryDom.pageErrors.join(" | "));
    assert(homeDom.pageErrors.length === 0, homeDom.pageErrors.join(" | "));
  });
  await check("existing category filters count and filter curated plus published photos together", () => {
    const status = galleryDoc.getElementById("galleryStatus");
    assert(/১৯টি ছবি|19টি ছবি/.test(status.textContent), status.textContent);
    const visible = () => [...galleryDoc.querySelectorAll("[data-gallery-item]")].filter((item) => !item.hidden).length;
    // one curated tile carries the tours tag, two published ones do too
    galleryDoc.querySelector('[data-filter="tours"]').dispatchEvent(new galleryDom.window.MouseEvent("click", { bubbles: true }));
    assert(visible() === 3, `tours visible ${visible()}`);
    // the tree tag exists only among the curated photos
    galleryDoc.querySelector('[data-filter="tree"]').dispatchEvent(new galleryDom.window.MouseEvent("click", { bubbles: true }));
    assert(visible() === 2, `tree visible ${visible()}`);
    assert(galleryDoc.querySelectorAll('[data-cms-photo]:not([hidden])').length === 0, "a published tile leaked into the tree filter");
    galleryDoc.querySelector('[data-filter="all"]').dispatchEvent(new galleryDom.window.MouseEvent("click", { bubbles: true }));
    assert(visible() === 19, `all visible ${visible()}`);
  });
  await check("lightbox opens for a CMS photo", () => {
    const trigger = galleryDoc.querySelector('[data-cms="gallery"] [data-cms-photo] [data-gallery-open]');
    trigger.dispatchEvent(new galleryDom.window.MouseEvent("click", { bubbles: true }));
    const image = galleryDoc.getElementById("lightboxImage");
    assert(image.getAttribute("src") === trigger.dataset.image, `lightbox src ${image.getAttribute("src")}`);
    assert(galleryDoc.getElementById("lightboxTitle").textContent.length > 0, "no lightbox title");
  });

  await check("one published photo means exactly 18 tiles: 17 curated plus it", async () => {
    const dom = await renderGalleryWith([feedAlbum("a1", "নবম শ্রেণির ক্লাসরুম", [feedPhoto("p1")])]);
    const items = gridItems(dom.window.document);
    assert(items.length === 18, `items ${items.length}`);
    assert(items[0].querySelector("img").getAttribute("src") === "assets/img/campus-hero.webp", "the curated first tile moved");
    assert(items[17].hasAttribute("data-cms-photo"), "the published tile is not the last one");
    assert(items[17].querySelector("img").getAttribute("src").startsWith("/api/media?path="), "not using the media route");
    assert(dom.pageErrors.length === 0, dom.pageErrors.join(" | "));
  });
  await check("every published photo is added, never a curated one removed", async () => {
    const dom = await renderGalleryWith([
      feedAlbum("a1", "বার্ষিক ক্রীড়া", [feedPhoto("p1"), feedPhoto("p2")]),
      feedAlbum("a2", "শিক্ষা সফর", [feedPhoto("p3"), feedPhoto("p4"), feedPhoto("p5")]),
    ]);
    const items = [...gridItems(dom.window.document)];
    assert(items.length === 22, `items ${items.length}`); // 17 + 5
    const curated = items.filter((item) => !item.hasAttribute("data-cms-photo"));
    assert(curated.length === 17, `curated ${curated.length}`);
    assert(new Set(items.filter((i) => i.hasAttribute("data-cms-photo")).map((i) => i.dataset.cmsPhoto)).size === 5, "not every published photo got a tile");
    assert(dom.pageErrors.length === 0, dom.pageErrors.join(" | "));
  });
  await check("the same photo id twice in a feed still yields one tile", async () => {
    const dom = await renderGalleryWith([
      feedAlbum("a1", "একই ছবি দুই অ্যালবামে", [feedPhoto("p1"), feedPhoto("p2")]),
      feedAlbum("a2", "দ্বিতীয় অ্যালবাম", [feedPhoto("p1")]),
    ]);
    const added = dom.window.document.querySelectorAll('[data-cms="gallery"] [data-cms-photo]');
    assert([...gridItems(dom.window.document)].length === 19, `items ${gridItems(dom.window.document).length}`);
    assert(added.length === 2, `added ${added.length}`);
    assert([...added].every((tile) => tile.dataset.cmsPhoto === "p1" || tile.dataset.cmsPhoto === "p2"), "unexpected tile ids");
  });
  await check("every added tile's media URL resolves 200 with an image content type", async () => {
    const srcs = [...galleryDoc.querySelectorAll('[data-cms="gallery"] [data-cms-photo] img')].map((img) => img.getAttribute("src"));
    assert(srcs.length === 2, `srcs ${srcs.length}`);
    for (const src of srcs) {
      const response = await fetch(`${BASE}${src}`);
      const type = response.headers.get("content-type") || "";
      assert(response.status === 200 && type.startsWith("image/"), `${src} → ${response.status} ${type}`);
      const full = galleryDoc.querySelector(`[data-cms-photo] [data-gallery-open][data-image]`)?.dataset.image;
      assert(src.includes("images%2F") && full.startsWith("/api/media?path="), "media url shape changed");
    }
  });

  console.log("\n— pages with no CMS hook are not touched by the content script —");
  for (const page of ["academics.html", "admission.html", "contact.html", "about.html"]) {
    await check(`${page} is byte-for-byte the authored page`, async () => {
      const plain = await render(page, { scripts: false });
      const withCms = await render(page, { scripts: "cms-only" });
      const main = (document) => document.querySelector("main").innerHTML;
      assert(main(withCms.window.document) === main(plain.window.document), "the content script altered the page");
      assert(withCms.window.document.querySelectorAll("[data-cms], [data-cms-photo]").length === 0, "a CMS container or tile appeared on a page without a hook");
      assert(withCms.pageErrors.length === 0, withCms.pageErrors.join(" | "));
    });
  }

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
