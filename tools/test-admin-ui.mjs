#!/usr/bin/env node
/* Drives the real admin screens in jsdom against the real API.
 *
 * Everything the Computer Teacher clicks — login, dashboard, the notice form,
 * publishing, the gallery uploader — is exercised here in order, so a typo in
 * admin.js or a mismatch between the form and the server fails this test rather
 * than surprising the school.
 *
 *   cd tools && npm install && npm run test:admin
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { JSDOM } from "jsdom";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = 8300 + Math.floor(Math.random() * 60);
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

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rahs-admin-"));
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
  stdio: ["ignore", "pipe", "pipe"],
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

const click = (dom, selector, label) => {
  const nodes = [...dom.window.document.querySelectorAll(selector)];
  const node = label ? nodes.find((candidate) => candidate.textContent.includes(label)) : nodes[0];
  if (!node) throw new Error(`no element for ${selector}${label ? ` containing “${label}”` : ""}`);
  node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  return node;
};

const setValue = (dom, selector, value) => {
  const node = dom.window.document.querySelector(selector);
  if (!node) throw new Error(`no input ${selector}`);
  node.value = value;
  node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  return node;
};

try {
  assert(await waitFor(async () => {
    try {
      return (await fetch(`${BASE}/api/public/health`)).ok;
    } catch {
      return false;
    }
  }), "dev server did not start: " + log);

  const html = await (await fetch(`${BASE}/admin/`)).text();
  const dom = new JSDOM(html, { url: `${BASE}/admin/`, runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.fetch = (input, init = {}) =>
    fetch(new URL(input, BASE), {
      ...init,
      headers: { ...(init.headers || {}), origin: BASE, cookie: dom.window.document.cookie },
    });
  dom.window.XMLHttpRequest = undefined; // uploads are covered by the API test suite
  const adminScript = await fs.readFile(path.join(ROOT, "admin/admin.js"), "utf8");

  // jsdom does not persist HttpOnly cookies, so mirror them manually for the app.
  const originalFetch = dom.window.fetch;
  dom.window.fetch = async (input, init = {}) => {
    const response = await originalFetch(input, init);
    for (const value of response.headers.getSetCookie?.() ?? []) {
      const [pair] = value.split(";");
      const [name] = pair.split("=");
      if (!/HttpOnly/i.test(value) || name === "rahs_csrf") dom.window.document.cookie = `${pair}; path=/`;
      else dom.window.document.cookie = `${pair}; path=/`; // jsdom ignores HttpOnly on write
    }
    return response;
  };

  dom.window.eval(adminScript);
  await waitFor(async () => !dom.window.document.getElementById("gate").hidden);

  console.log("\n— gate —");
  await check("a fresh install shows the first-run setup form, not the login form", () => {
    assert(!dom.window.document.getElementById("setupForm").hidden, "setup form hidden");
    assert(dom.window.document.getElementById("loginForm").hidden, "login form should be hidden before setup");
  });

  console.log("\n— first-run account —");
  await check("setup creates the account and enters the dashboard", async () => {
    setValue(dom, "#setupName", "কম্পিউটার শিক্ষক");
    setValue(dom, "#setupEmail", "teacher@school.edu");
    setValue(dom, "#setupPassword", "bidyalaya-2026");
    click(dom, "#setupForm button[type=submit]");
    assert(
      await waitFor(async () => {
        const viewNode = dom.window.document.getElementById("view");
        return viewNode && !viewNode.hidden && viewNode.textContent.includes("ড্যাশবোর্ড");
      }),
      `dashboard never rendered. view="${dom.window.document.getElementById("view")?.textContent?.slice(0, 160)}" log=${log.slice(-500)}`,
    );
  });
  await check("top bar shows the signed-in teacher and logout", () => {
    assert(dom.window.document.getElementById("whoami").textContent.includes("কম্পিউটার শিক্ষক"), dom.window.document.getElementById("whoami").textContent);
    assert(!dom.window.document.getElementById("tabAccounts").hidden, "admin should see the accounts tab");
  });
  await check("every sidebar tab routes to its own screen", async () => {
    /* A tab whose href is not a real route falls through to the dashboard, so an
     * admin menu can silently open the wrong section (gallery once pointed at
     * #/gallery while the resource is #/albums). Each tab is therefore clicked
     * from the dashboard, and must move the screen off it. */
    const onDashboard = () => dom.window.document.querySelector("#view h1")?.textContent.trim() === "ড্যাশবোর্ড";
    const backToDashboard = async () => {
      dom.window.location.hash = "#/";
      dom.window.dispatchEvent(new dom.window.Event("hashchange"));
      assert(await waitFor(onDashboard), "the dashboard tab must open the dashboard");
    };
    await backToDashboard();
    const tabs = [...dom.window.document.querySelectorAll("#tabs .tab")]
      .map((tab) => ({ tab, href: tab.getAttribute("href") || "" }))
      .filter(({ tab, href }) => !tab.hidden && href.startsWith("#/") && href !== "#/");
    assert(tabs.length >= 5, `only ${tabs.length} routed tabs to check`);
    for (const { tab, href } of tabs) {
      dom.window.location.hash = href;
      dom.window.dispatchEvent(new dom.window.Event("hashchange"));
      const heading = await waitFor(() => {
        const title = dom.window.document.querySelector("#view h1")?.textContent.trim();
        return title && title !== "ড্যাশবোর্ড" ? title : null;
      }, 40);
      assert(heading, `${href} left the dashboard on screen — that href is not a route the admin knows`);
      const active = dom.window.document.querySelector('#tabs .tab[aria-current="page"]');
      assert(active === tab, `${href} left “${active?.textContent?.trim() || "no tab"}” marked as the current tab`);
      await backToDashboard();
    }
  });
  await check("dashboard lists counts for every managed section", () => {
    const text = dom.window.document.getElementById("view").textContent;
    for (const label of ["নোটিশ", "পরীক্ষার রুটিন", "অন্যান্য রুটিন", "গ্যালারি"]) {
      assert(text.includes(label), `missing ${label} on the dashboard`);
    }
    assert(dom.window.document.querySelectorAll("#view .stat").length === 4, "expected four stat cards");
  });

  console.log("\n— notices workflow —");
  await check("the new-notice form is built from the server schema", async () => {
    dom.window.location.hash = "#/notices/new";
    dom.window.dispatchEvent(new dom.window.Event("hashchange"));
    assert(
      await waitFor(() => dom.window.document.querySelector("#view form [data-field=title]")),
      `form did not appear: ${dom.window.document.getElementById("view").textContent.slice(0, 200)}`,
    );
    const form = dom.window.document.querySelector("#view form");
    for (const name of ["title", "body", "audience", "notice_type", "importance", "published_at", "status", "file"]) {
      assert(form.querySelector(`[data-field="${name}"]`), `missing field ${name}`);
    }
    assert(form.querySelector('[data-field="published_at"] input').value.match(/^\d{4}-\d{2}-\d{2}$/), "publication date should default to today");
    const types = [...form.querySelectorAll('[data-field="notice_type"] option')].map((option) => option.textContent);
    assert(types.includes("পরীক্ষা") && types.includes("ফলাফল"), `type options: ${types.join(",")}`);
  });
  await check("a draft saved from the form stays off the public site", async () => {
    setValue(dom, '#view [data-field="title"] input', "নবম শ্রেণির অর্ধ-বার্ষিক পরীক্ষার রুটিন");
    setValue(dom, '#view [data-field="body"] textarea', "২০ অক্টোবর থেকে পরীক্ষা শুরু হবে।\\nশিক্ষার্থীদের অ্যাডমিট কার্ড আনতে হবে।".replace(/\\\\n/g, "\n"));
    setValue(dom, '#view [data-field="audience"] input', "নবম শ্রেণি");
    click(dom, "#view .form-foot button", "সংরক্ষণ করুন");
    assert(
      await waitFor(async () => {
        const { json } = await (await fetch(`${BASE}/api/cms/notices`, { headers: { cookie: dom.window.document.cookie } })).json().then((body) => ({ json: body }));
        return json?.items?.length === 1;
      }),
      `notice not created: ${log.slice(-400)}`,
    );
    const feed = await (await fetch(`${BASE}/api/public/notices`)).json();
    assert(feed.notices.length === 0, "a draft must not be visible publicly");
  });
  await check("publishing from the list makes it public", async () => {
    dom.window.location.hash = "#/notices";
    dom.window.dispatchEvent(new dom.window.Event("hashchange"));
    assert(await waitFor(() => dom.window.document.querySelector('#view .row [data-status], #view .row .chip')), "list did not render");
    click(dom, "#view .row-foot button", "প্রকাশ করুন");
    assert(
      await waitFor(async () => (await (await fetch(`${BASE}/api/public/notices`)).json()).notices.length === 1),
      "public feed still empty after publishing",
    );
  });

  console.log("\n— validation is shown in the form —");
  await check("a required field left empty is refused with a field message", async () => {
    dom.window.location.hash = "#/notices/new";
    dom.window.dispatchEvent(new dom.window.Event("hashchange"));
    assert(await waitFor(() => dom.window.document.querySelector('#view [data-field="body"] textarea')), "form did not reopen");
    setValue(dom, '#view [data-field="title"] input', "খুব ছোট");
    setValue(dom, '#view [data-field="body"] textarea', "");
    setValue(dom, '#view [data-field="status"] select', "published");
    const buttons = [...dom.window.document.querySelectorAll("#view .form-foot button")].map((b) => b.textContent);
    click(dom, "#view .form-foot button", "সংরক্ষণ");
    assert(
      await waitFor(() => {
        const slot = dom.window.document.querySelector('[data-field="body"] .err');
        return slot && !slot.hidden;
      }),
      `no inline error for an empty body (buttons=${JSON.stringify(buttons)}; hash=${dom.window.location.hash}; toast=${JSON.stringify(dom.window.document.getElementById("toast").textContent)}; formPresent=${Boolean(dom.window.document.querySelector("#view form"))}; view=${JSON.stringify(dom.window.document.getElementById("view").textContent.slice(0, 160))})`,
    );
  });

  console.log("\n— gallery and accounts screens —");
  await check("album form offers the existing gallery categories", async () => {
    dom.window.location.hash = "#/albums/new";
    dom.window.dispatchEvent(new dom.window.Event("hashchange"));
    assert(await waitFor(() => dom.window.document.querySelector('#view [data-field="category"] select')), "album form missing");
    const options = [...dom.window.document.querySelectorAll('#view [data-field="category"] option')].map((option) => option.textContent);
    assert(options.includes("শিক্ষা সফর") && options.includes("খেলাধুলা ও মাঠ"), options.join(","));
    assert(!dom.window.document.querySelector('#view [data-field="cover_photo_id"]'), "cover photo must not be a raw id box");
  });
  await check("saving a new album lands on the photo picker, not the list", async () => {
    // Photos can only join an album that already exists, so the album form has no
    // file control of its own — the screen it hands over to has to be that picker.
    setValue(dom, '#view [data-field="title"] input', "স্বর্ণ জয়ন্তী বর্ষের উদ্বোধন");
    click(dom, "#view .form-foot button", "সংরক্ষণ করুন");
    assert(
      await waitFor(() => dom.window.document.getElementById("photoFiles")),
      `the picker never appeared (hash=${dom.window.location.hash}, view=${JSON.stringify(dom.window.document.getElementById("view").textContent.slice(0, 160))})`,
    );
    const picker = dom.window.document.getElementById("photoFiles");
    assert(picker.type === "file" && picker.multiple, "the album flow must end at the multi-file picker");
    assert(dom.window.document.querySelector("#view h1").textContent.includes("ছবি:"), `not the photo screen: ${dom.window.document.querySelector("#view h1").textContent}`);
    assert([...dom.window.document.querySelectorAll("#view .dropzone button")].some((button) => button.textContent.includes("আপলোড করুন")), "no upload button next to the picker");
  });
  await check("the photo screen has a multi-file picker and an upload button", async () => {
    dom.window.location.hash = "#/albums";
    dom.window.dispatchEvent(new dom.window.Event("hashchange"));
    const created = await fetch(`${BASE}/api/cms/albums`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie: dom.window.document.cookie, "x-csrf-token": /rahs_csrf=([^;]+)/.exec(dom.window.document.cookie)?.[1] ?? "" },
      body: JSON.stringify({ title: "বার্ষিক ক্রীড়া ২০২৬", category: "sports", published_at: "2026-10-01", status: "draft" }),
    });
    const { item } = await created.json();
    dom.window.location.hash = `#/albums/${item.id}/photos`;
    dom.window.dispatchEvent(new dom.window.Event("hashchange"));
    assert(await waitFor(() => dom.window.document.getElementById("photoFiles")), "photo screen did not load");
    const picker = dom.window.document.getElementById("photoFiles");
    assert(picker.multiple, "the picker must allow several photos at once");
    assert([...dom.window.document.querySelectorAll("#view button")].some((button) => button.textContent.includes("আপলোড করুন")), "no upload button");
    assert([...dom.window.document.querySelectorAll("#view button")].some((button) => button.textContent.includes("প্রকাশ করুন")), "no publish button");
  });
  /* ---- gallery upload batching -------------------------------------------------
   * Vercel refuses any function request whose body passes 4.5 MB, which is *below*
   * the server's own per-file limit, so a selection sent as one multipart body died
   * with a bare "HTTP 413" before our API ran and Supabase never saw a byte. The
   * admin now splits a selection into safe cumulative batches. These checks drive the
   * real doUpload against a recording XMLHttpRequest: no request is ever sent, so not
   * even the local test store receives a file — nothing is uploaded anywhere.
   */
  console.log("\n— gallery upload batching —");
  const MB = 1024 * 1024;
  const SAFE_BATCH_BYTES = 3.5 * MB;
  const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

  const installFakeUploads = ({ failOn = 0 } = {}) => {
    const requests = [];
    let inFlight = 0;
    let peakInFlight = 0;
    class FakeXHR {
      constructor() {
        this.listeners = {};
        this.upload = { addEventListener: () => {} };
      }
      open(method, url) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader() {}
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      }
      send(formData) {
        const record = { url: this.url, fields: {}, files: [], bytes: 0 };
        for (const [key, value] of formData.entries()) {
          if (typeof value === "string") record.fields[key] = value;
          else {
            record.files.push({ name: value.name, size: value.size, type: value.type, blob: value });
            record.bytes += value.size;
          }
        }
        requests.push(record);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        setTimeout(() => {
          inFlight -= 1;
          this.status = requests.length === failOn ? 413 : 201;
          this.responseText =
            this.status === 201
              ? JSON.stringify({ ok: true, photos: record.files.map((file) => ({ id: `p-${file.name}`, name: file.name })), failed: [] })
              : "FUNCTION_PAYLOAD_TOO_LARGE"; // the host's own body: not JSON, so the app can only quote the status
          this.listeners.load?.();
        }, 2);
      }
    }
    dom.window.XMLHttpRequest = FakeXHR;
    return { requests, peak: () => peakInFlight };
  };

  const photoFile = (name, size) => {
    const bytes = new Uint8Array(size);
    bytes.set(new TextEncoder().encode(`RAW:${name}:`)); // a marker the app must not disturb
    return new dom.window.File([bytes], name, { type: "image/jpeg" });
  };

  const readHead = (blob, n = 24) =>
    new Promise((resolve, reject) => {
      const reader = new dom.window.FileReader();
      reader.onload = () => resolve(String(reader.result).slice(0, n));
      reader.onerror = () => reject(new Error("the recorded upload could not be read back"));
      reader.readAsText(blob.slice(0, n));
    });

  /* The picker, the status line and the upload button must all come from one render,
   * or a screen that is still being replaced would be measured instead of the one the
   * click actually reaches. */
  const openPhotoScreen = async (title) => {
    const created = await fetch(`${BASE}/api/cms/albums`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie: dom.window.document.cookie, "x-csrf-token": /rahs_csrf=([^;]+)/.exec(dom.window.document.cookie)?.[1] ?? "" },
      body: JSON.stringify({ title, category: "campus", published_at: "2026-10-01", status: "draft" }),
    });
    const { item } = await created.json();
    dom.window.location.hash = `#/albums/${item.id}/photos`;
    dom.window.dispatchEvent(new dom.window.Event("hashchange"));
    assert(
      await waitFor(() => dom.window.document.querySelector("#view h1")?.textContent.includes(title) && dom.window.document.getElementById("photoFiles"), 80),
      `the photo screen for “${title}” never opened`,
    );
    return item.id;
  };

  const hintsOf = (root = dom.window.document) => [...root.querySelectorAll("#view .hint")].map((node) => node.textContent).join(" | ");

  const pickFiles = (files) => {
    const picker = dom.window.document.getElementById("photoFiles");
    Object.defineProperty(picker, "files", { value: files, configurable: true, writable: false });
    picker.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    return picker;
  };

  await check("eight 1.4 MB photos go out as several requests, none over the safe budget", async () => {
    const albumId = await openPhotoScreen("batching — eight photos");
    const fake = installFakeUploads();
    try {
      const files = Array.from({ length: 8 }, (_, index) => photoFile(`photo-${index + 1}.jpg`, Math.round(1.4 * MB)));
      pickFiles(files);
      click(dom, "#view button", "আপলোড করুন");
      assert(await waitFor(() => fake.requests.length === 4, 160), `expected 4 requests, saw ${fake.requests.length}`);
      const sizes = fake.requests.map((request) => request.files.length).join(",");
      assert(sizes === "2,2,2,2", `batch sizes were ${sizes}`);
      for (const request of fake.requests) {
        assert(request.bytes <= SAFE_BATCH_BYTES, `a request carried ${(request.bytes / MB).toFixed(2)} MB`);
        assert(request.fields.album_id === albumId, "a batch was aimed at the wrong album");
        assert(request.url === "/api/cms/photos?action=upload", `unexpected endpoint ${request.url}`);
      }
      const names = new Set(fake.requests.flatMap((request) => request.files.map((file) => file.name)));
      assert(names.size === 8, `only ${names.size} of 8 photos left the browser`);
      assert(fake.peak() === 1, `${fake.peak()} requests were in flight at once — they must go one after another`);
    } finally {
      dom.window.XMLHttpRequest = undefined;
    }
  });

  await check("the per-request file-count limit still bounds a batch of small photos", async () => {
    await openPhotoScreen("batching — fourteen small photos");
    const fake = installFakeUploads();
    try {
      const files = Array.from({ length: 14 }, (_, index) => photoFile(`small-${index + 1}.jpg`, 1024));
      pickFiles(files);
      click(dom, "#view button", "আপলোড করুন");
      assert(await waitFor(() => fake.requests.length === 3, 160), `expected 3 requests, saw ${fake.requests.length}`);
      const sizes = fake.requests.map((request) => request.files.length).join(",");
      assert(sizes === "6,6,2", `batch sizes were ${sizes} — maxImagesPerUpload must still cap each request`);
      const names = new Set(fake.requests.flatMap((request) => request.files.map((file) => file.name)));
      assert(names.size === 14, `only ${names.size} of 14 photos were sent`);
    } finally {
      dom.window.XMLHttpRequest = undefined;
    }
  });

  await check("a photo larger than the budget travels alone, unchanged", async () => {
    await openPhotoScreen("batching — one oversized photo");
    const fake = installFakeUploads();
    try {
      const big = photoFile("camera-original.jpg", Math.round(5 * MB));
      const small = photoFile("phone-shot.jpg", 1 * MB);
      pickFiles([big, small]);
      click(dom, "#view button", "আপলোড করুন");
      assert(await waitFor(() => fake.requests.length === 2, 160), `expected 2 requests, saw ${fake.requests.length}`);
      const first = fake.requests[0];
      assert(first.files.length === 1 && first.files[0].name === "camera-original.jpg", `the oversized photo shared its request: ${JSON.stringify(first.files.map((f) => f.name))}`);
      assert(first.files[0].size === big.size, `size changed on the way out: ${first.files[0].size} vs ${big.size}`);
      assert(first.files[0].type === "image/jpeg", "the declared type changed");
      assert((await readHead(first.files[0].blob)).startsWith("RAW:camera-original.jpg:"), "the bytes were transformed on the way out");
      assert(fake.requests[1].files.map((file) => file.name).join() === "phone-shot.jpg", "the second photo was swallowed with the first");
    } finally {
      dom.window.XMLHttpRequest = undefined;
    }
  });

  await check("a request the host refuses stops the run, says so, and keeps the rest selected", async () => {
    await openPhotoScreen("batching — refused by the host");
    const fake = installFakeUploads({ failOn: 2 });
    try {
      const files = Array.from({ length: 8 }, (_, index) => photoFile(`shot-${index + 1}.jpg`, Math.round(1.4 * MB)));
      const picker = pickFiles(files);
      click(dom, "#view button", "আপলোড করুন");
      assert(await waitFor(() => fake.requests.length === 2, 160), `expected to stop after 2 requests, saw ${fake.requests.length}`);
      await settle(30);
      assert(fake.requests.length === 2, `kept firing after a refusal (${fake.requests.length} requests)`);
      const said = hintsOf();
      assert(said.includes("আপলোড থেমে গেছে") && said.includes("HTTP 413"), `the screen did not report the refusal: ${said}`);
      assert(said.includes("বাকি 6টি"), `the screen did not say how many photos remain: ${said}`);
      assert(picker.files.length === 8, "the failed selection was cleared from the picker");
    } finally {
      dom.window.XMLHttpRequest = undefined;
    }
  });

  await check("the upload screen states the real per-request limit", async () => {
    await openPhotoScreen("batching — wording");
    const lines = [...dom.window.document.querySelectorAll("#view p")].map((node) => node.textContent).join(" | ") + hintsOf();
    assert(lines.includes("3.5 MB"), "the batching budget this screen applies is not stated");
    assert(lines.includes("4.5 MB"), "the host's real request ceiling is not stated, so 3.5 MB would look like an invented rule");
    assert(lines.includes("4.4 MB"), "the screen does not say plainly that one very large file cannot be uploaded at all");
    assert(lines.includes("8 MB"), "the server's own per-file limit stopped being mentioned");
    assert(lines.includes("বাতিল"), "the screen does not say the host refuses an oversized request");
    assert(!/বেশি হলে কয়েকবারে দিন/.test(lines), "the screen still tells the teacher to split selections by hand");
    await settle();
  });

  await check("account screen changes a password", async () => {
    dom.window.location.hash = "#/account";
    dom.window.dispatchEvent(new dom.window.Event("hashchange"));
    assert(await waitFor(() => dom.window.document.getElementById("pwNext")), "account screen missing");
    setValue(dom, "#pwCurrent", "wrong-current-pass");
    setValue(dom, "#pwNext", "brand-new-pass-2026");
    click(dom, "#view button", "পাসওয়ার্ড বদলান");
    assert(
      await waitFor(() => /বর্তমান পাসওয়ার্ড/.test(dom.window.document.getElementById("toast").textContent)),
      `toast said: ${JSON.stringify(dom.window.document.getElementById("toast").textContent)}`,
    );
    assert(dom.window.document.querySelectorAll("#pwCurrent, #pwNext").length === 2, "password inputs missing");
  });
  await check("logout returns to the login gate", async () => {
    click(dom, "#logoutButton");
    assert(await waitFor(() => !dom.window.document.getElementById("gate").hidden), "gate never came back");
    assert(dom.window.document.getElementById("setupForm").hidden, "after setup the login form should show, not setup");
  });
} catch (error) {
  results.push({ name: "harness", pass: false, detail: error?.stack || String(error) });
  console.error(error);
} finally {
  server.kill("SIGTERM");
  await fs.rm(tempDir, { recursive: true, force: true });
}

const failed = results.filter((row) => !row.pass);
if (log.includes("Error")) console.log("\n— server stderr tail —\n" + log.slice(-1500));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nfailures:\n" + failed.map((row) => `  ✗ ${row.name} — ${row.detail}`).join("\n"));
  process.exitCode = 1;
}
