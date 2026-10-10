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

  /**
   * The bytes of a real PNG, padded to a chosen size. The direct path finishes at the
   * server's own validation, so synthetic bytes would be refused for being a non-image
   * instead of proving what this is about — that a big *photo* now gets through.
   */
  const realPhoto = async (name, size, type = "image/png") => {
    const base = await fs.readFile(path.join(ROOT, "file_000000007e208211b50fdcafeeae9f2e.png"));
    const bytes = base.length >= size ? base.subarray(0, size) : Buffer.concat([base, Buffer.alloc(size - base.length, 0x5a)]);
    return new dom.window.File([bytes], name, { type });
  };
  const readBytes = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new dom.window.FileReader();
      reader.onload = () => resolve(Buffer.from(reader.result));
      reader.onerror = () => reject(new Error("the request body could not be read back"));
      reader.readAsArrayBuffer(blob);
    });

  /**
   * Stands in for the *platform*, not for the app. Every request is forwarded to the
   * real API and the real store, and any request whose body passes the host's 4.5 MB
   * ceiling is answered the way the host answers it — 413, non-JSON, before the app's
   * own code runs. So an upload of 5.76 MB that succeeds here has actually avoided
   * that ceiling rather than been promised its way past it.
   */
  const installHost = ({ maxRequestBody = Math.round(4.5 * MB), breakPut = false, putStatus = 0, putBody = "" } = {}) => {
    const seen = { requests: [], apiCalls: [], inFlight: 0, peak: 0 };
    const csrf = () => /rahs_csrf=([^;]+)/.exec(dom.window.document.cookie)?.[1] ?? "";
    const originalFetch = dom.window.fetch;
    dom.window.fetch = async (input, init = {}) => {
      const url = String(input);
      if (/action=(begin|commit|abort)/.test(url)) {
        const body = typeof init.body === "string" ? init.body : "";
        const response = await originalFetch(input, init);
        const entry = { url, method: init.method, bytes: Buffer.byteLength(body), body };
        if (/action=commit/.test(url)) {
          // The row the API actually accepted: the album view deliberately omits
          // bytes/mime, so the response is the only place they can be checked.
          entry.photo = await response
            .clone()
            .json()
            .then((payload) => payload?.photo ?? null)
            .catch(() => null);
        }
        seen.apiCalls.push(entry);
        return response;
      }
      return originalFetch(input, init);
    };
    class FakeXHR {
      constructor() {
        this.listeners = {};
        this.headers = {};
        this.upload = { addEventListener: () => {} };
      }
      open(method, url) {
        this.method = method;
        this.url = url;
      }
      setRequestHeader(name, value) {
        this.headers[name] = String(value);
      }
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      }
      async send(body) {
        const isForm = body instanceof dom.window.FormData;
        const record = { url: this.url, method: this.method, headers: { ...this.headers }, files: [], bytes: 0, form: isForm };
        seen.requests.push(record);
        seen.inFlight += 1;
        seen.peak = Math.max(seen.peak, seen.inFlight);
        let status = 0;
        let text = "";
        try {
          if (isForm) {
            const form = new FormData();
            for (const [key, value] of body.entries()) {
              if (typeof value === "string") {
                form.append(key, value);
                continue;
              }
              const bytes = await readBytes(value);
              record.bytes += bytes.length;
              record.files.push({ name: value.name, size: value.size, type: value.type, blob: value });
              form.append(key, new Blob([bytes], { type: value.type || "application/octet-stream" }), value.name);
            }
            if (record.bytes > maxRequestBody) {
              status = 413; // the host's own answer, with no JSON in it
              text = "FUNCTION_PAYLOAD_TOO_LARGE";
            } else {
              const sent = await fetch(`${BASE}${this.url}`, {
                method: "POST",
                body: form,
                headers: { cookie: dom.window.document.cookie, "x-csrf-token": csrf(), origin: BASE },
              });
              status = sent.status;
              text = await sent.text();
            }
          } else {
            const bytes = await readBytes(body);
            record.bytes = bytes.length;
            record.files.push({ name: body.name, size: body.size, type: body.type, blob: body });
            if (putStatus) {
              /* Storage refusing a file it was handed — a bucket size limit or MIME list
               * says no in its own body, and that answer is the only clue the teacher gets. */
              status = putStatus;
              text = putBody;
            } else if (breakPut) {
              status = 0; // the connection died with the file already partly sent
              text = "";
            } else {
              const sent = await fetch(`${BASE}${this.url}`, {
                method: this.method || "PUT",
                body: bytes,
                headers: { "content-type": this.headers["content-type"] || "application/octet-stream" },
              });
              status = sent.status;
              text = await sent.text();
            }
          }
        } catch (error) {
          status = 0;
          text = String(error?.message || error);
        }
        seen.inFlight -= 1;
        record.status = status;
        record.responseText = text;
        this.status = status;
        this.responseText = text;
        this.listeners.load?.();
      }
    }
    dom.window.XMLHttpRequest = FakeXHR;
    return {
      requests: seen.requests,
      apiCalls: seen.apiCalls,
      peak: () => seen.peak,
      forms: () => seen.requests.filter((entry) => entry.form),
      puts: () => seen.requests.filter((entry) => !entry.form),
      restore: () => {
        dom.window.XMLHttpRequest = undefined;
        dom.window.fetch = originalFetch;
      },
    };
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

  let oversizedAlbumId = "";

  /** What the store actually holds for an album, read over the same API the admin uses. */
  const storedPhotos = async (albumId) => {
    const response = await fetch(`${BASE}/api/cms/albums?id=${albumId}`, { headers: { cookie: dom.window.document.cookie, origin: BASE } });
    return (await response.json())?.item?.photos ?? [];
  };

  await check("a photo too big for one request is PUT to the grant instead, byte for byte", async () => {
    oversizedAlbumId = await openPhotoScreen("batching — one 5.76 MB photo");
    const host = installHost();
    try {
      const big = await realPhoto("edited-photo.png", 5_760_000); // what the teacher's edit measured
      pickFiles([big]);
      click(dom, "#view button", "আপলোড করুন");
      // The commit row is read from the recorded response, and the recorder only holds
      // `photo` once it has cloned and parsed that response — so wait for the
      // observation too, not just for the album. Otherwise this races itself.
      assert(
        await waitFor(
          async () =>
            (await storedPhotos(oversizedAlbumId)).length === 1 &&
            host.apiCalls.some((entry) => /action=commit/.test(entry.url) && entry.photo),
          300,
        ),
        `the photo never landed. requests=${JSON.stringify(host.requests.map((entry) => [entry.url, entry.bytes]))} api=${JSON.stringify(host.apiCalls.map((entry) => [entry.url, entry.bytes]))}`,
      );
      // The file never touched the endpoint the host refuses at this size.
      assert(host.forms().length === 0, `an oversized photo was sent as a form upload (${host.forms().length} requests)`);
      const puts = host.puts();
      assert(puts.length === 1, `expected one direct write, saw ${puts.length}`);
      assert(/action=put/.test(puts[0].url), `the grant pointed somewhere else: ${puts[0].url}`);
      assert(puts[0].bytes === 5_760_000, `the grant received ${puts[0].bytes} bytes for a 5760000 byte file`);
      const sent = await readBytes(puts[0].files[0].blob);
      assert(
        sent.length === 5_760_000 && sent.subarray(0, 4).toString("hex") === "89504e47" && sent[5_759_999] === 0x5a,
        "the bytes were transformed on the way out",
      );
      assert(puts[0].files[0].name === "edited-photo.png" && puts[0].files[0].type === "image/png", "name or type changed");
      assert(!puts[0].headers.cookie && !puts[0].headers.authorization && !puts[0].headers["x-csrf-token"], "a session credential was sent to storage");
      // The API only ever saw a key and a name — nothing that could pass a ceiling.
      const begin = host.apiCalls.find((entry) => entry.url.includes("action=begin"));
      const commit = host.apiCalls.find((entry) => entry.url.includes("action=commit"));
      assert(begin && commit, `begin/commit are missing: ${JSON.stringify(host.apiCalls.map((entry) => entry.url))}`);
      assert(begin.bytes < 400 && commit.bytes < 400, `the API calls carried ${begin.bytes}/${commit.bytes} bytes`);
      assert(!host.apiCalls.some((entry) => entry.url.includes("action=abort")), "a completed upload was aborted");
      const photo = commit.photo;
      assert(photo && photo.bytes === 5_760_000 && photo.mime === "image/png", `the row the server accepted: ${JSON.stringify(photo)}`);
      // Dimensions come from the bytes the server read back, never from the client.
      assert(photo.pixel_width > 0 && photo.pixel_height > 0, `dimensions not sniffed: ${photo.pixel_width}x${photo.pixel_height}`);
      const [row] = await storedPhotos(oversizedAlbumId);
      assert(row && row.id === photo.id, `the album does not list the committed photo: ${JSON.stringify(row)}`);
      assert(String(photo.url).startsWith("/api/media?path=images%2F"), `url not routed through /api/media: ${photo.url}`);
      // The media route streams, so there is no content-length to trust: read it back.
      const media = await fetch(`${BASE}${photo.url}`, { headers: { cookie: dom.window.document.cookie, origin: BASE } });
      const servedBytes = (await media.arrayBuffer()).byteLength;
      assert(media.status === 200 && servedBytes === 5_760_000, `the stored photo served ${media.status} / ${servedBytes} bytes`);
    } finally {
      host.restore();
      await settle();
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

  await check("the upload screen states the real limits, for what this server can do", async () => {
    await openPhotoScreen("batching — wording");
    const lines = [...dom.window.document.querySelectorAll("#view p")].map((node) => node.textContent).join(" | ") + hintsOf();
    assert(lines.includes("3.5 MB"), "the batching budget this screen applies is not stated");
    assert(lines.includes("4.5 MB"), "the host's real request ceiling is not stated, so 3.5 MB would look like an invented rule");
    assert(lines.includes("8 MB"), "the server's own per-file limit stopped being mentioned");
    assert(lines.includes("বাতিল"), "the screen does not say the host refuses an oversized request");
    // This deployment can issue grants, so the screen must say the big ones go to
    // storage — and must stop claiming a 5 MB photo is impossible to upload.
    assert(/সরাসরি স্টোরেজে/.test(lines), "the screen does not mention the direct route large photos now take");
    assert(!/যে কোনো ভাবেই আপলোড হবে না/.test(lines), "the screen still calls an oversized photo impossible while it can go direct");
    assert(!/বেশি হলে কয়েকবারে দিন/.test(lines), "the screen still tells the teacher to split selections by hand");
    await settle();
  });

  await check("a mixed selection keeps the order the teacher picked them in", async () => {
    const albumId = await openPhotoScreen("batching — mixed sizes");
    const host = installHost();
    try {
      const files = [
        await realPhoto("first-small.png", 300_000),
        await realPhoto("second-small.png", 400_000),
        await realPhoto("third-huge.png", 5_760_000),
      ];
      pickFiles(files);
      click(dom, "#view button", "আপলোড করুন");
      // Both halves have to be observed: the album in the store, and the commit response
      // this check reads the server's answer out of (recorded a beat after it resolves).
      const settled = async () =>
        host.apiCalls.some((entry) => /action=commit/.test(entry.url) && entry.photo) && (await storedPhotos(albumId)).length === 3;
      assert(
        await waitFor(settled, 300),
        `only ${(await storedPhotos(albumId)).length} of 3 photos arrived (commit recorded: ${host.apiCalls.filter((entry) => /action=commit/.test(entry.url)).map((entry) => Boolean(entry.photo)).join(",") || "none"})`,
      );
      assert(host.forms().length === 1 && host.puts().length === 1, `expected one batch plus one direct write, saw ${host.requests.length} requests`);
      assert(host.forms()[0].files.map((file) => file.name).join() === "first-small.png,second-small.png", "the small photos did not travel together");
      assert(host.puts()[0].files[0].name === "third-huge.png", "the oversized photo did not go on its own");
      assert(host.peak() === 1, `${host.peak()} requests were in flight at once`);
      const formPhotos = JSON.parse(host.forms()[0].responseText || "{}").photos ?? [];
      const directPhoto = host.apiCalls.find((entry) => entry.url.includes("action=commit"))?.photo;
      const created = [...formPhotos, directPhoto].filter(Boolean);
      assert(created.length === 3, `only ${created.length} of 3 photos were confirmed by the server`);
      assert(
        created.map((entry) => entry.bytes).join() === "300000,400000,5760000",
        `the server recorded sizes in a different order: ${JSON.stringify(created.map((entry) => entry.bytes))}`,
      );
      const stored = await storedPhotos(albumId);
      assert(
        stored.map((entry) => entry.sort_order).join() === "0,1,2",
        `the album ended up in order ${JSON.stringify(stored.map((entry) => [entry.sort_order, entry.pixel_width]))}`,
      );
    } finally {
      host.restore();
      await settle();
    }
  });

  await check("a refusal from the bucket is quoted, so storage is not blamed on this app", async () => {
    /* Supabase applies the bucket's own file_size_limit and allowed_mime_types inside the
     * signed-upload route as well, so a file this app accepted can still be refused there.
     * What matters is what the teacher is told: the storage answer verbatim, the remaining
     * files untouched, and the staging object handed back. */
    const albumId = await openPhotoScreen("batching — bucket refusal");
    const host = installHost({
      putStatus: 413,
      putBody: '{"statusCode":"413","error":"EntityTooLarge","message":"Max size allowed has been exceeded"}',
    });
    try {
      pickFiles([await realPhoto("too-big-for-bucket.png", 5_000_000)]);
      click(dom, "#view button", "আপলোড করুন");
      assert(await waitFor(() => /HTTP 413/.test(hintsOf()), 200), `the bucket's answer never reached the screen: ${hintsOf()}`);
      assert(/থেমে গেছে|আটকে গেছে/.test(hintsOf()), `the upload did not report a stop: ${hintsOf()}`);
      assert(/স্টোরেজ ছবিটি নেয়নি/.test(hintsOf()), `the refusal was not attributed to storage: ${hintsOf()}`);
      assert(/Max size allowed has been exceeded/.test(hintsOf()), `the bucket's own reason was dropped: ${hintsOf()}`);
      assert((await storedPhotos(albumId)).length === 0, "a photo was registered for bytes the bucket refused");
      const aborted = host.apiCalls.find((entry) => entry.url.includes("action=abort"));
      assert(aborted, "the staged bytes were not handed back after a bucket refusal");
      assert(host.forms().length === 0, `a refused direct upload fell back to a form request: ${JSON.stringify(host.forms())}`);
    } finally {
      host.restore();
    }
  });

  await check("a direct write that dies mid-flight is handed back and registers nothing", async () => {
    const albumId = await openPhotoScreen("batching — interrupted upload");
    const host = installHost({ breakPut: true });
    try {
      pickFiles([await realPhoto("cut-off.png", 5_000_000)]);
      click(dom, "#view button", "আপলোড করুন");
      assert(
        await waitFor(() => /থেমে গেছে|আটকে গেছে/.test(hintsOf()), 200),
        `the screen never reported the failure: ${hintsOf()}`,
      );
      assert((await storedPhotos(albumId)).length === 0, "a photo was registered for bytes that never arrived");
      const aborted = host.apiCalls.find((entry) => entry.url.includes("action=abort"));
      assert(aborted, `the unfinished upload was not handed back: ${JSON.stringify(host.apiCalls.map((entry) => entry.url))}`);
      assert(/staging_key/.test(aborted.body), "the abort did not name the staging object to clear");
      assert(dom.window.document.getElementById("photoFiles").files.length === 1, "the interrupted selection was thrown away");
      // And the same selection succeeds once the connection behaves: nothing was half-done.
      host.restore();
      const retry = installHost();
      try {
        click(dom, "#view button", "আপলোড করুন");
        assert(
          await waitFor(async () => (await storedPhotos(albumId)).length === 1, 300),
          `the retry never landed: ${JSON.stringify(retry.requests.map((entry) => [entry.url, entry.bytes, entry.status]))}`,
        );
        assert(retry.puts().length === 1 && retry.forms().length === 0, "the retry did not take the direct route again");
      } finally {
        retry.restore();
      }
    } finally {
      host.restore();
      await settle();
    }
  });

  /**
   * The same deployed admin.js mounted a second time, on a deployment that reports it
   * cannot issue grants. Whatever the teacher then reads has to match what that server
   * can really do — no promise of a direct upload it has no way to authorise, and no
   * photo quietly dropped instead of being reported.
   */
  const mountWithoutDirectUploads = async () => {
    const secondHtml = await (await fetch(`${BASE}/admin/`)).text();
    const second = new JSDOM(secondHtml, { url: `${BASE}/admin/`, runScripts: "outside-only", pretendToBeVisual: true });
    const realCall = (input, init = {}) =>
      fetch(new URL(input, BASE), { ...init, headers: { ...(init.headers || {}), origin: BASE, cookie: second.window.document.cookie } });
    second.window.fetch = async (input, init = {}) => {
      const response = await realCall(input, init);
      for (const value of response.headers.getSetCookie?.() ?? []) {
        const [pair] = value.split(";");
        second.window.document.cookie = `${pair}; path=/`;
      }
      if (String(input).includes("/api/cms/status")) {
        const payload = await response.json().catch(() => null);
        if (payload?.limits) payload.limits.directUploads = false;
        return new Response(JSON.stringify(payload ?? {}), { status: response.status, headers: { "content-type": "application/json" } });
      }
      return response;
    };
    second.window.XMLHttpRequest = undefined;
    second.window.eval(await fs.readFile(path.join(ROOT, "admin/admin.js"), "utf8"));
    assert(await waitFor(() => !second.window.document.getElementById("gate").hidden, 200), "the second gate never rendered");
    for (const [selector, value] of [["#loginEmail", "teacher@school.edu"], ["#loginPassword", "bidyalaya-2026"]]) {
      const node = second.window.document.querySelector(selector);
      node.value = value;
      node.dispatchEvent(new second.window.Event("input", { bubbles: true }));
    }
    second.window.document
      .querySelector("#loginForm button[type=submit]")
      .dispatchEvent(new second.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    assert(
      await waitFor(() => second.window.document.querySelector("#view h1")?.textContent.includes("ড্যাশবোর্ড"), 200),
      "the second session never opened the dashboard",
    );
    return second;
  };

  await check("without grants the screen drops its promises and loses nothing silently", async () => {
    const second = await mountWithoutDirectUploads();
    second.window.location.hash = `#/albums/${oversizedAlbumId}/photos`;
    second.window.dispatchEvent(new second.window.Event("hashchange"));
    assert(await waitFor(() => second.window.document.getElementById("photoFiles"), 200), "the photo screen never opened in the second session");
    await settle();
    const copy = [...second.window.document.querySelectorAll("#view p, #view .hint")].map((node) => node.textContent.trim()).join(" | ");
    assert(copy.includes("3.5 MB") && copy.includes("4.5 MB") && copy.includes("8 MB"), `limits missing from the fallback wording: ${copy}`);
    assert(/আপলোড হবে না/.test(copy) && copy.includes("4.4 MB"), "the fallback screen should still say a too-large file cannot be uploaded here");
    assert(!/সরাসরি স্টোরেজে/.test(copy), "the fallback screen promised a direct upload this server cannot authorise");

    const seen = [];
    const apiSeen = [];
    const original = second.window.fetch;
    second.window.fetch = async (input, init = {}) => {
      if (/action=(begin|commit)/.test(String(input))) apiSeen.push(String(input));
      return original(input, init);
    };
    class Recorder {
      constructor() {
        this.listeners = {};
        this.headers = {};
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
      send(body) {
        const files = [];
        let bytes = 0;
        for (const [key, value] of body.entries()) {
          if (typeof value !== "string") {
            files.push({ name: value.name, size: value.size });
            bytes += value.size;
          }
        }
        seen.push({ url: this.url, files, bytes });
        setTimeout(() => {
          this.status = 413; // the host, as it really answers at this size
          this.responseText = "FUNCTION_PAYLOAD_TOO_LARGE";
          this.listeners.load?.();
        }, 2);
      }
    }
    second.window.XMLHttpRequest = Recorder;
    try {
      const picker2 = second.window.document.getElementById("photoFiles");
      Object.defineProperty(picker2, "files", { value: [await realPhoto("on-a-server-without-grants.png", 5_760_000)], configurable: true, writable: false });
      picker2.dispatchEvent(new second.window.Event("change", { bubbles: true }));
      const uploadButton = [...second.window.document.querySelectorAll("#view button")].find((node) => node.textContent.includes("আপলোড করুন"));
      assert(uploadButton, "the second screen has no upload button to click");
      uploadButton.dispatchEvent(new second.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      for (let attempt = 0; attempt < 200 && !/থেমে গেছে/.test([...second.window.document.querySelectorAll("#view .hint")].map((node) => node.textContent).join(" | ")); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const reported = [...second.window.document.querySelectorAll("#view .hint")].map((node) => node.textContent).join(" | ");
      assert(/থেমে গেছে/.test(reported), `the refusal was never reported: ${reported}`);
      assert(/HTTP 413/.test(reported), `the message hid which layer refused it: ${reported}`);
      assert(seen.length === 1 && /action=upload/.test(seen[0].url), `the oversized photo went somewhere unexpected: ${JSON.stringify(seen.map((entry) => entry.url))}`);
      assert(apiSeen.length === 0, `a server that cannot grant was asked for one: ${JSON.stringify(apiSeen)}`);
      assert(picker2.files.length === 1, "the failed selection was thrown away");
    } finally {
      second.window.XMLHttpRequest = undefined;
      second.window.fetch = original;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
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
