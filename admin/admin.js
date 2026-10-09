/* Admin dashboard application.
 *
 * Plain ES module, no build step and no framework — the same constraint the public
 * site lives under. Three rules shape the whole file:
 *   1. every string that comes from the API is written with textContent, never
 *      innerHTML, so stored content cannot execute;
 *   2. field labels/types come from /api/cms/schema, so the form and the server
 *      validation can never drift apart;
 *   3. any call that reads drafts or writes data is a normal authenticated fetch —
 *      the server decides, so hiding a button is never the security model.
 */

const RESOURCES = {
  notices: { entity: "notice", label: "নোটিশ", singular: "নোটিশ", add: "+ নতুন নোটিশ যোগ করুন", note: "ওয়েবসাইটের নোটিশ পাতায় প্রকাশিত সবার উপরে দেখানো হবে।" },
  exams: { entity: "exam", label: "পরীক্ষার রুটিন", singular: "পরীক্ষার রুটিন", add: "+ পরীক্ষার রুটিন যোগ করুন", note: "বিষয়ভিত্তিক তারিখ ও সময়; প্রকাশিতটি নোটিশ পাতায় দেখানো হবে।" },
  routines: { entity: "routine", label: "অন্যান্য রুটিন", singular: "রুটিন", add: "+ রুটিন যোগ করুন", note: "শ্রেণি রুটিন, অনুষ্ঠান, ছুটি — যেকোনো ধরনের সময়সূচি।" },
  albums: { entity: "album", label: "গ্যালারি / অ্যালবাম", singular: "অ্যালবাম", add: "+ নতুন অ্যালবাম তৈরি করুন", note: "প্রথমে অ্যালবামটি সংরক্ষণ করুন — এরপর ছবি যোগ করার পর্দা খুলে যাবে, সেখানে ফোনের গ্যালারি থেকে ছবি বেছে নিন। তালিকায় প্রতিটি অ্যালবামের “ছবি” বোতাম দিয়েও যেতে পারবেন। ছবি না দিলে অ্যালবাম প্রকাশ পাবে না।" },
};

const STATUS_LABELS = { draft: "খসড়া", published: "প্রকাশিত", unpublished: "অপ্রকাশিত" };
const ENTITY_OF = Object.fromEntries(Object.entries(RESOURCES).map(([key, value]) => [key, value.entity]));

const state = { me: null, schema: null, limits: null, filters: {}, dirty: false };

/* ------------------------------------------------------------------ plumbing */

const $ = (selector) => document.querySelector(selector);
const view = $("#view");

/* Only the newest render may write to the screen. A response that arrives late
 * (slow network, a list refreshing behind a newly opened form) must not wipe out
 * what the teacher is looking at, so every renderer claims a number and checks it
 * before it paints. */
let renderSeq = 0;
const claimRender = () => ++renderSeq;

const h = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return node;
};

let toastTimer = null;
const toast = (message, tone = "ok") => {
  const node = $("#toast");
  node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), tone === "danger" ? 7000 : 3500);
  $("#live").textContent = message;
};

class ApiError extends Error {
  constructor(message, status, fields) {
    super(message);
    this.status = status;
    this.fields = fields ?? null;
  }
}

const api = async (path, { method = "GET", body, silent = false } = {}) => {
  const headers = { origin: location.origin };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") headers["x-csrf-token"] = document.cookie.match(/rahs_csrf=([^;]+)/)?.[1] ?? "";
  let response;
  try {
    response = await fetch(`/api/cms${path}`, {
      method,
      headers,
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError("ইন্টারনেট সংযোগ বা সার্ভারে সমস্যা — একটু পরে আবার চেষ্টা করুন।", 0);
  }
  if (response.status === 401 && state.me) {
    state.me = null;
    showGate("session");
    throw new ApiError("সেশন শেষ হয়ে গেছে — আবার প্রবেশ করুন।", 401);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.message || `অনুরোধ ব্যর্থ (HTTP ${response.status})`;
    if (!silent) toast(message, "danger");
    throw new ApiError(message, response.status, payload?.fields);
  }
  return payload;
};

const uploadFiles = (path, formData, onProgress) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-csrf-token", document.cookie.match(/rahs_csrf=([^;]+)/)?.[1] ?? "");
    xhr.upload.addEventListener("progress", (event) => {
      if (onProgress && event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      let payload = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
      else reject(new ApiError(payload?.message || `আপলোড ব্যর্থ (HTTP ${xhr.status})`, xhr.status, payload?.fields));
    });
  xhr.addEventListener("error", () => reject(new ApiError("আপলোড আটকে গেছে — সংযোগ পরীক্ষা করুন।", 0)));
  xhr.addEventListener("abort", () => reject(new ApiError("আপলোড বাতিল করা হয়েছে।", 0)));
  xhr.send(formData);
  });

/**
 * PUTs one file into the storage object the server just allocated for it.
 *
 * Deliberately sent without the session: no cookie, no CSRF header, `withCredentials`
 * left false. The capability is the single-use token inside the grant URL, and it
 * permits exactly one write to one new key — nothing else in the bucket, nothing that
 * already exists. The bytes go out untouched, the same as on the form path.
 */
const putToStorage = (grant, file, onProgress) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(grant.method || "PUT", grant.upload_url);
    for (const [name, value] of Object.entries(grant.headers ?? {})) {
      try {
        xhr.setRequestHeader(name, String(value));
      } catch {
        /* a header this runtime owns (content-length and friends) — storage does not need it */
      }
    }
    xhr.upload.addEventListener("progress", (event) => {
      if (onProgress && event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(true);
      /* A bucket can refuse a file for its own reason (its configured size limit, for
       * instance) and say so in its response — quoting that status verbatim is the only
       * way a teacher learns the storage refused rather than this app. */
      const detail = String(xhr.responseText || "").replace(/\s+/g, " ").trim().slice(0, 160);
      reject(new ApiError(`স্টোরেজ ছবিটি নেয়নি (HTTP ${xhr.status}${detail ? ` · ${detail}` : ""})`, xhr.status));
    });
    xhr.addEventListener("error", () => reject(new ApiError("স্টোরেজে ছবিটি পাঠানো যায়নি — সংযোগ পরীক্ষা করুন।", 0)));
    xhr.addEventListener("abort", () => reject(new ApiError("স্টোরেজে ছবিটি পাঠানো বাতিল হয়েছে।", 0)));
    xhr.send(file);
  });

/* A Vercel function refuses any request whose body passes 4.5 MB — a ceiling *below*
 * the per-file limit this app's server applies (api/_lib/config.mjs: maxImageBytes is
 * 8 MB, maxFormBytes 24 MB). So a picker that put every chosen photo into one
 * multipart body failed with a bare "আপলোড ব্যর্থ (HTTP 413)": the host rejected the
 * request before api/cms/[...path].mjs ran, and Supabase never saw a byte. The admin
 * therefore groups a selection into requests that stay inside a safe share of that
 * ceiling and sends them one after another.
 *
 * 3.5 MB, rather than 4.4 MB, leaves room for the multipart framing plus the
 * album_id / alt_text fields and for the host measuring the whole request instead of
 * the file. Nothing here resizes, re-encodes or drops anything: the bytes the teacher
 * picked are the bytes that go out, and size, type and permission remain the
 * server's decision. A big file simply travels alone, which is how a 4 MB photo still
 * gets through under a 4.5 MB ceiling — and why a file past that ceiling cannot be
 * sent at all, exactly as the hints below tell the teacher. */
const UPLOAD_HOST_LIMIT_MB = 4.5; // Vercel's own ceiling, and it is not configurable
const UPLOAD_FILE_LIMIT_MB = 4.4; // a single file above this cannot pass that ceiling in any arrangement
const UPLOAD_REQUEST_BUDGET_MB = 3.5; // what this screen aims for, leaving the host some room
const UPLOAD_REQUEST_BUDGET_BYTES = Math.round(UPLOAD_REQUEST_BUDGET_MB * 1024 * 1024);
const UPLOAD_FILE_LIMIT_BYTES = Math.round(UPLOAD_FILE_LIMIT_MB * 1024 * 1024);

/** Groups files into requests of at most maxBytes and at most maxFiles files. */
const planUploadBatches = (files, { maxBytes = UPLOAD_REQUEST_BUDGET_BYTES, maxFiles = 6 } = {}) => {
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const file of files || []) {
    const size = Number(file?.size) || 0;
    // An oversized file is never split, shrunk or skipped: it gets its own request.
    if (batch.length && (bytes + size > maxBytes || batch.length >= maxFiles)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
};

/**
 * A file too big for the form budget still has a way in: this screen asks the API for a
 * short-lived grant that points at one brand-new object in the bucket and PUTs the bytes
 * there, then asks the API to verify and register what arrived. Only that tiny JSON
 * handshake passes through a function. `DirectUnavailable` is how the server says it
 * cannot issue grants — not an error to show, a reason to use the form path.
 */
class DirectUnavailable extends Error {
  constructor(reason) {
    super(reason || "সরাসরি আপলোড এই সার্ভারে চালু নেই।");
    this.name = "DirectUnavailable";
  }
}

/** Whether this deployment can hand out storage grants (unknown until /status replies). */
const directUploadsEnabled = () => state.limits?.directUploads !== false;

/**
 * Turns one selection into the ordered list of requests that will carry it: consecutive
 * small photos share a multipart request, anything larger is PUT to storage alone.
 * The teacher's picking order is kept, so the album ends up in that order too. A file
 * is never resized, re-encoded, split or skipped — it only changes which door it uses.
 */
const planUploadSteps = (files, { maxBytes = UPLOAD_REQUEST_BUDGET_BYTES, directBytes = UPLOAD_FILE_LIMIT_BYTES, maxFiles = 6, direct = false } = {}) => {
  const steps = [];
  let batch = [];
  let bytes = 0;
  const flush = () => {
    if (batch.length) steps.push({ kind: "form", batch });
    batch = [];
    bytes = 0;
  };
  for (const file of files || []) {
    const size = Number(file?.size) || 0;
    /* The form path still carries a lone photo up to the host's ceiling, so storage is
     * used only where the platform physically cannot take the request — not merely
     * because a batch would have been big. */
    if (direct && size > directBytes) {
      flush();
      steps.push({ kind: "direct", file });
      continue;
    }
    if (batch.length && (bytes + size > maxBytes || batch.length >= maxFiles)) flush();
    batch.push(file);
    bytes += size;
  }
  flush();
  return steps;
};

const uploadBytes = (file) => `${(Number(file?.size || 0) / (1024 * 1024)).toFixed(1)} MB`;

/* The limits a teacher is told about have to be the limits of the server this screen is
 * actually talking to — promising that a large photo will get through is only honest
 * when that server can issue the storage grant that makes it possible. */
const photoLimitHint = () => {
  const shared =
    `সমর্থিত: JPEG, PNG, WebP। সার্ভার প্রতিটি ছবিতে সর্বোচ্চ ${state.limits?.maxImageMb ?? 8} MB চল দেয়, কিন্তু হোস্ট ${UPLOAD_HOST_LIMIT_MB} MB-এর বড় অনুরোধ বাতিল করে — তাই ছবিগুলো ${UPLOAD_REQUEST_BUDGET_MB} MB-এর ছোট ছোট অনুরোধে ভাগ হয়ে যায়।`;
  return directUploadsEnabled()
    ? shared +
        ` যে ছবি ${UPLOAD_FILE_LIMIT_MB} MB-এরও বড় — একটি অনুরোধে হোস্ট তাকে ধরে না — সেটি ফর্মের অনুরোধে না গিয়ে সরাসরি স্টোরেজে আপলোড হয়, তাই বড় ছবিও এখন ওঠে। সার্ভার আসল বাইট দেখেই সীমা মাপে।`
    : shared + ` একটি ছবি ${UPLOAD_FILE_LIMIT_MB} MB-এরও বড় হলে সেটি যে কোনো ভাবেই আপলোড হবে না — আগে ছোট (২০০০ পিক্সেলের নিচে) করে নিন।`;
};

const photoStatusHint = (count) =>
  `এই অ্যালবামে ${count}টি ছবি। একসাথে যত খুশি বেছে নিন — প্রতিটি অনুরোধ ${UPLOAD_REQUEST_BUDGET_MB} MB-এর বেশি হবে না${
    directUploadsEnabled() ? ", বড় ছবিগুলো সরাসরি স্টোরেজে যায়" : ""
  }।`;

const confirmAction = ({ title, body, word = null, danger = true, yesLabel = "হ্যাঁ, করুন" }) =>
  new Promise((resolve) => {
    const dialog = $("#confirmDialog");
    $("#confirmTitle").textContent = title;
    $("#confirmBody").textContent = body;
    const typeField = $("#confirmTypeField");
    const input = $("#confirmWord");
    input.value = "";
    typeField.hidden = !word;
    $("#confirmYes").textContent = yesLabel;
    $("#confirmYes").className = danger ? "btn btn-danger" : "btn";
    const finish = (value) => {
      dialog.close();
      resolve(value);
    };
    const onYes = () => finish(!word || input.value.trim().toUpperCase() === word);
    $("#confirmYes").addEventListener("click", onYes, { once: true });
    $("#confirmNo").addEventListener("click", () => finish(false), { once: true });
    dialog.addEventListener("close", () => finish(false), { once: true });
    dialog.showModal();
    (word ? input : $("#confirmYes")).focus();
  });

const today = () => new Date(new Date().getTimezoneOffset() * -60000).toISOString().slice(0, 10);
const timeOf = (value) => (value ? String(value).slice(0, 5) : "");

/* ---------------------------------------------------------------- the gate */

const showGate = (mode = "login") => {
  $("#appbar").hidden = true;
  $("#tabs").hidden = true;
  view.hidden = true;
  $("#gate").hidden = false;
  $("#loginForm").hidden = mode === "setup";
  $("#setupForm").hidden = mode !== "setup";
  $("#gateTitle").textContent = mode === "setup" ? "সেটআপ: প্রথম অ্যাকাউন্ট" : "ওয়েবসাইট কনটেন্ট ব্যবস্থাপনা";
  if (mode === "expired") toast("সেশন শেষ হয়েছে — আবার প্রবেশ করুন।", "danger");
  if (mode === "login") $("#loginEmail").focus();
};

const enterApp = async () => {
  $("#gate").hidden = true;
  $("#appbar").hidden = false;
  $("#tabs").hidden = false;
  view.hidden = false;
  $("#whoami").textContent = `${state.me.fullName} · ${state.me.role === "admin" ? "অ্যাডমিন" : "স্টাফ"}`;
  $("#tabAccounts").hidden = !state.me.isAdmin;
  const [schemaResponse, statusResponse] = await Promise.all([api("/schema"), api("/status", { silent: true })]);
  state.schema = schemaResponse.schema;
  state.limits = statusResponse.limits;
  if (statusResponse.configProblems?.length) toast(`সার্ভার সেটআপ: ${statusResponse.configProblems.join(" ")}`, "danger");
  window.addEventListener("hashchange", route);
  route();
};

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#loginSubmit");
  const error = $("#loginError");
  error.hidden = true;
  button.disabled = true;
  button.textContent = "যাচাই করা হচ্ছে…";
  try {
    const payload = await api("/login", {
      method: "POST",
      silent: true,
      body: { email: $("#loginEmail").value, password: $("#loginPassword").value },
    });
    state.me = payload.user;
    $("#loginPassword").value = "";
    await enterApp();
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
    $("#loginPassword").select();
  } finally {
    button.disabled = false;
    button.textContent = "প্রবেশ করুন";
  }
});

$("#setupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("#setupError");
  error.hidden = true;
  try {
    const payload = await api("/setup", {
      method: "POST",
      silent: true,
      body: {
        full_name: $("#setupName").value,
        email: $("#setupEmail").value,
        password: $("#setupPassword").value,
      },
    });
    state.me = payload.user;
    toast("অ্যাকাউন্ট তৈরি হয়েছে। এখন থেকে CMS_ALLOW_SETUP সরিয়ে ফেলুন।");
    await enterApp();
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  }
});

const logout = async () => {
  try {
    await api("/logout", { method: "POST", silent: true });
  } finally {
    state.me = null;
    showGate("login");
    toast("প্রস্থান করা হয়েছে।");
  }
};

$("#logoutButton").addEventListener("click", logout);
$("#logoutTab").addEventListener("click", (event) => {
  event.preventDefault();
  logout();
});

/* -------------------------------------------------------------------- router */

const route = async () => {
  const [path = "", arg = "", third = ""] = location.hash.replace(/^#\/?/, "").split("/");
  document.title = "কনটেন্ট ব্যবস্থাপনা | রাজাপুর আদর্শ উচ্চ বিদ্যালয়";
  for (const tab of document.querySelectorAll(".tab")) {
    const target = tab.getAttribute("href") || "";
    const active = target === `#/${path}` || (path === "" && target === "#/");
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  try {
    if (!path) return renderDashboard();
    if (path === "accounts") return renderAccounts();
    if (path === "account") return renderMyAccount();
    if (RESOURCES[path]) {
      if (!arg) return renderList(path);
      if (arg === "new") return renderForm(path, null);
      if (third === "photos") return renderAlbum(path, arg);
      return renderForm(path, arg);
    }
    return renderDashboard();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return showGate("expired");
    renderError(error);
  }
};

const renderError = (error) => {
  view.replaceChildren(
    h("div", { class: "stack" }, [
      h("div", { class: "notice-line", dataset: { tone: "danger" } }, `এই অংশটি খোলা যায়নি: ${error?.message || "অজানা ত্রুটি"}`),
      h("button", { class: "btn btn-quiet", type: "button", onclick: () => location.assign("#/") }, "ড্যাশবোর্ডে ফিরুন"),
    ]),
  );
  view.focus();
};

const head = (title, note, actions = []) =>
  h("div", { class: "view-head" }, [
    h("div", {}, [h("h1", { text: title }), note ? h("p", { text: note }) : null]),
    actions.length ? h("div", { class: "view-actions" }, actions) : null,
  ]);

/* ---------------------------------------------------------------- dashboard */

const renderDashboard = async () => {
  const seq = claimRender();
  const data = await api("/dashboard");
  if (seq !== renderSeq) return;
  const quick = Object.entries(RESOURCES).map(([key, spec]) =>
    h("a", { class: "btn btn-quiet", href: `#/${key}` }, `${spec.label} (${data.totals[key].published + data.totals[key].draft})`),
  );
  view.replaceChildren(
    head("ড্যাশবোর্ড", "ওয়েবসাইটে যা এখন দেখানো হচ্ছে তার সারসংক্ষেপ। নিচের যেকোনো বোতামে চাপ দিয়ে কনটেন্ট যোগ বা পরিবর্তন করুন।", [
      h("a", { class: "btn btn-gold", href: "#/notices/new" }, "+ নতুন নোটিশ যোগ করুন"),
    ]),

    h("div", { class: "stat-grid" }, Object.entries(RESOURCES).map(([key, spec]) => {
      const totals = data.totals[key];
      return h("div", { class: "stat" }, [
        h("strong", { text: String(totals.published) }),
        h("span", { text: `${spec.label} — প্রকাশিত` }),
        h("span", { text: `খসড়া ${totals.draft} · বাতিল ঘরে ${totals.trashed}` }),
        h("a", { href: `#/${key}`, text: "খুলুন →" }),
      ]);
    })),

    h("div", { class: "stack" }, [
      h("h2", { text: "দ্রুত কাজ", style: "margin:.4rem 0 0;font-size:1rem" }),
      h("div", { class: "view-actions" }, quick),
    ]),

    h("div", { class: "stack" }, [
      h("h2", { text: "সাম্প্রতিক কার্যক্রম", style: "margin:.4rem 0 0;font-size:1rem" }),
      data.recent.length
        ? h("div", { class: "rows" }, data.recent.map((row) =>
            h("div", { class: "row" }, [
              h("p", { class: "row-title", text: `${actionLabel(row.action)} — ${row.entity}` }),
              h("p", { class: "row-meta" }, [
                h("span", { text: row.email || "—" }),
                h("span", { text: row.detail || "" }),
                h("span", { text: new Date(row.at).toLocaleString("bn-BD") }),
              ]),
            ]),
          ))
        : h("p", { class: "row-body", text: "এখনো কোনো কার্যক্রম নেই।" }),
    ]),

    h("div", {
      class: "notice-line",
      text:
        `সংরক্ষণ ব্যবস্থা: ${data.storage.driver === "supabase" ? "Supabase (প্রোডাকশন)" : "লোকাল ডেভ (শুধু পরীক্ষার জন্য)"} · সর্বোচ্চ ছবি ${Math.round(data.storage?.limits?.maxImageMb ?? state.limits?.maxImageMb ?? 8)} MB · একটি অনুরোধে হোস্ট ${UPLOAD_HOST_LIMIT_MB} MB পর্যন্ত চলে, তাই ছবি ${UPLOAD_REQUEST_BUDGET_MB} MB-এর অনুরোধে ভাগ হয়ে পাঠানো হয়` +
        (data.storage?.limits?.directUploads === false ? " · বড় ছবি সরাসরি স্টোরেজে পাঠানো এই সার্ভারে চালু নেই" : " · যে ছবি এই সীমারও বড়, সেটি সরাসরি স্টোরেজে পাঠানো হয়"),
    }),
  );
  view.focus();
};

const actionLabel = (action) =>
  ({
    login: "প্রবেশ",
    logout: "প্রস্থান",
    setup: "সেটআপ",
    create: "নতুন তৈরি",
    update: "সম্পাদনা",
    publish: "প্রকাশ",
    unpublish: "অপ্রকাশ",
    trash: "বাতিল ঘরে",
    restore: "ফিরিয়ে আনা",
    purge: "স্থায়ীভাবে মুছে ফেলা",
    photo_add: "ছবি যোগ",
    photo_update: "ছবি সম্পাদনা",
    photo_move: "ছবির ক্রম",
    photo_trash: "ছবি বাতিল ঘরে",
    photo_purge: "ছবি মুছে ফেলা",
    account_create: "নতুন অ্যাকাউন্ট",
    account_update: "অ্যাকাউন্ট পরিবর্তন",
    password_change: "পাসওয়ার্ড পরিবর্তন",
  })[action] || action;

/* ---------------------------------------------------------------- list view */

const FILTERS = [
  ["", "সব"],
  ["published", "প্রকাশিত"],
  ["draft", "খসড়া"],
  ["unpublished", "অপ্রকাশিত"],
];

const renderList = async (resource) => {
  const seq = claimRender();
  const spec = RESOURCES[resource];
  const filter = state.filters[resource] ?? { status: "", deleted: false };
  const query = new URLSearchParams();
  if (filter.status) query.set("status", filter.status);
  if (filter.q) query.set("q", filter.q);
  if (filter.deleted) query.set("deleted", "1");
  const suffix = query.toString() ? `?${query}` : "";
  const data = await api(`/${resource}${suffix}`);
  if (seq !== renderSeq) return;

  const filterButtons = [
    ...FILTERS.map(([value, label]) =>
      h("button", {
        class: `btn btn-small ${filter.status === value && !filter.deleted ? "" : "btn-quiet"}`,
        type: "button",
        onclick: () => {
          state.filters[resource] = { ...filter, status: value, deleted: false };
          route();
        },
      }, label),
    ),
    h("button", {
      class: `btn btn-small ${filter.deleted ? "" : "btn-quiet"}`,
      type: "button",
      onclick: () => {
        state.filters[resource] = { ...filter, deleted: true, status: "" };
        route();
      },
    }, `বাতিল ঘর`),
  ];

  const search = h("input", {
    type: "search",
    value: filter.q || "",
    placeholder: "খুঁজুন…",
    "aria-label": `${spec.label} খুঁজুন`,
    oninput: (event) => {
      state.filters[resource] = { ...filter, q: event.target.value };
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => route(), 350);
    },
  });
  let searchTimer = null;

  view.replaceChildren(
    head(spec.label, spec.note, [
      h("a", { class: "btn btn-gold", href: `#/${resource}/new` }, spec.add),
    ]),
    h("div", { class: "stack" }, [
      h("div", { class: "view-actions" }, filterButtons),
      filter.deleted ? h("div", { class: "notice-line" }, "বাতিল ঘরের আইটেম ওয়েবসাইটে দেখানো হয় না। ফিরিয়ে আনা বা চিরতরে মুছে ফেলা যেতে পারে।") : null,
      search,
      data.items.length
        ? h("div", { class: "rows" }, data.items.map((row) => (filter.deleted ? renderTrashRow(resource, row) : renderRow(resource, row))))
        : h("p", { class: "card", text: filter.deleted ? "বাতিল ঘর খালি।" : `এখনো কোনো ${spec.singular} নেই। “${spec.add.replace("+ ", "")}” চাপুন।` }),
    ]),
  );
  view.focus();
};

const rowTitle = (resource, row) =>
  resource === "exams" ? `${row.exam_name} — ${row.class_name}, ${row.subject}` : row.title;

const rowMeta = (resource, row) => {
  const parts = [
    h("span", { class: `chip`, dataset: { status: row.status }, text: STATUS_LABELS[row.status] || row.status }),
    row.date_label ? h("span", { text: row.date_label }) : null,
    resource === "notices" && row.audience ? h("span", { text: row.audience }) : null,
    resource === "exams" && row.start_time ? h("span", { text: `সময় ${timeOf(row.start_time)}` }) : null,
    resource === "exams" && row.room ? h("span", { text: row.room }) : null,
    resource === "routines" && row.routine_type ? h("span", { text: row.routine_type }) : null,
    resource === "albums" ? h("span", { text: `${row.photo_count ?? 0}টি ছবি` }) : null,
    row.importance === "urgent" ? h("span", { class: "chip", dataset: { status: "unpublished" }, text: "জরুরি" }) : null,
    row.file_name ? h("span", { text: `সংযুক্তি: ${row.file_name}` }) : null,
  ];
  return h("p", { class: "row-meta" }, parts.filter(Boolean));
};

const renderRow = (resource, row) => {
  const spec = RESOURCES[resource];
  const actions = [
    h("a", { class: "btn btn-quiet btn-small", href: `#/${resource}/${row.id}` }, "সম্পাদনা"),
    row.status === "published"
      ? h("button", { class: "btn btn-quiet btn-small", type: "button", onclick: () => setStatus(resource, row.id, "unpublish") }, "অপ্রকাশ করুন")
      : h("button", {
          class: "btn btn-small",
          type: "button",
          onclick: () => setStatus(resource, row.id, "publish").then(() => (resource === "albums" ? route() : null)),
        }, "প্রকাশ করুন"),
    resource === "albums" ? h("a", { class: "btn btn-quiet btn-small", href: `#/${resource}/${row.id}/photos` }, "ছবি") : null,
    h("button", { class: "btn btn-danger btn-small", type: "button", onclick: () => trashItem(resource, row) }, "বাতিল ঘরে"),
  ];
  return h("div", { class: "row" }, [
    h("div", { class: "album-head" }, [
      resource === "albums" && row.cover_url ? h("img", { class: "row-thumb", src: row.cover_url, alt: "", loading: "lazy" }) : null,
      h("div", { class: "row-main" }, [
        h("p", { class: "row-title", text: rowTitle(resource, row) }),
        rowMeta(resource, row),
        resource !== "albums" && row.body ? h("p", { class: "row-body", text: clip(row.body, 160) }) : null,
        resource === "exams" && row.notes ? h("p", { class: "row-body", text: clip(row.notes, 120) }) : null,
        resource === "routines" && row.description ? h("p", { class: "row-body", text: clip(row.description, 160) }) : null,
      ]),
    ]),
    h("div", { class: "row-foot" }, actions),
  ]);
};

const renderTrashRow = (resource, row) =>
  h("div", { class: "row" }, [
    h("div", { class: "row-main" }, [
      h("p", { class: "row-title", text: rowTitle(resource, row) }),
      rowMeta(resource, row),
    ]),
    h("div", { class: "row-foot" }, [
      h("button", { class: "btn btn-quiet btn-small", type: "button", onclick: () => restoreItem(resource, row.id) }, "ফিরিয়ে আনুন"),
      h("button", { class: "btn btn-danger btn-small", type: "button", onclick: () => purgeItem(resource, row) }, "চিরতরে মুছুন"),
    ]),
  ]);

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

const setStatus = async (resource, id, action) => {
  await api(`/${resource}?id=${encodeURIComponent(id)}&action=${action}`, { method: "POST" });
  toast(action === "publish" ? "প্রকাশিত হয়েছে — ওয়েবসাইটে দেখা যাচ্ছে।" : "ওয়েবসাইট থেকে সরানো হয়েছে।");
  route();
};

const trashItem = async (resource, row) => {
  const spec = RESOURCES[resource];
  const yes = await confirmAction({
    title: `${spec.singular} বাতিল ঘরে নেবেন?`,
    body: `“${rowTitle(resource, row)}” ওয়েবসাইট থেকে সরে যাবে, কিন্তু মুছে যাবে না — চাইলে ফিরিয়ে আনতে পারবেন।`,
    yesLabel: "বাতিল ঘরে নিন",
  });
  if (!yes) return;
  await api(`/${resource}?id=${encodeURIComponent(row.id)}&action=trash`, { method: "POST" });
  toast("বাতিল ঘরে রাখা হয়েছে। যেকোনো সময় ফিরিয়ে আনা যাবে।");
  route();
};

const restoreItem = async (resource, id) => {
  await api(`/${resource}?id=${encodeURIComponent(id)}&action=restore`, { method: "POST" });
  toast("ফিরিয়ে আনা হয়েছে।");
  route();
};

const purgeItem = async (resource, row) => {
  const yes = await confirmAction({
    title: "চিরতরে মুছে ফেলবেন?",
    body: `“${rowTitle(resource, row)}” একবার মুছে গেলে আর ফেরানো যাবে না। সংযুক্ত ছবি বা ফাইলও মুছে যাবে।`,
    word: "DELETE",
    yesLabel: "হ্যাঁ, চিরতরে মুছুন",
  });
  if (!yes) return;
  await api(`/${resource}?id=${encodeURIComponent(row.id)}&action=purge`, { method: "POST", body: { confirm: "DELETE" } });
  toast("চিরতরে মুছে ফেলা হয়েছে।");
  route();
};

/* ----------------------------------------------------------------- form view */

const field = (name, rule, value, form) => {
  const id = `f_${name}`;
  const error = h("p", { class: "err", id: `${id}_error`, role: "alert", hidden: true });
  const hint = rule.hint ? h("p", { class: "hint", text: rule.hint }) : null;
  let control;

  if (rule.type === "media") {
    const fileInput = h("input", { id, type: "file", accept: "image/jpeg,image/png,image/webp,image/gif,application/pdf" });
    const status = h("p", { class: "hint", text: value ? `সংযুক্ত: ${value.name || "ফাইল"}` : "এখনো কোনো ফাইল সংযুক্ত নেই।" });
    const bar = h("div", { class: "bar", hidden: true }, h("i", { style: "width:0%" }));
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      bar.hidden = false;
      status.textContent = "আপলোড হচ্ছে…";
      const data = new FormData();
      data.set("file", file, file.name);
      try {
        const payload = await uploadFiles("/api/cms/upload", data, (percent) => (bar.firstChild.style.width = `${percent}%`));
        form.files[name] = payload.file;
        status.textContent = `সংযুক্ত: ${payload.file.name} (${Math.round(payload.file.bytes / 1024)} KB)`;
        removeBtn.hidden = false;
      } catch (failure) {
        status.textContent = failure.message;
        fileInput.value = "";
      } finally {
        bar.hidden = true;
      }
    });
    const removeBtn = h(
      "button",
      {
        class: "btn btn-quiet btn-small",
        type: "button",
        hidden: !value,
        onclick: () => {
          delete form.files[name];
          fileInput.value = "";
          status.textContent = "এখনো কোনো ফাইল সংযুক্ত নেই।";
          removeBtn.hidden = true;
        },
      },
      "সরান",
    );
    control = h("div", { class: "stack" }, [fileInput, status, bar, removeBtn]);
    form.fileFields.push(name);
  } else if (rule.type === "select" || rule.type === "status") {
    const values = rule.values;
    const labels = rule.labels || values.map((value) => (rule.type === "status" ? STATUS_LABELS[value] || value : value));
    const chosen = value ?? rule.default ?? values[0];
    control = h(
      "select",
      { id, name },
      values.map((entry, index) => h("option", { value: entry, selected: entry === chosen, text: labels[index] })),
    );
    if (rule.type === "status") control.dataset.role = "status";
  } else if (rule.type === "textarea") {
    control = h("textarea", { id, name, rows: rule.max > 1500 ? 10 : 5, placeholder: rule.placeholder || "" });
    control.value = value ?? "";
  } else if (rule.type === "int") {
    control = h("input", { id, name, type: "number", min: rule.min ?? 0, max: rule.max ?? 9999, value: value ?? rule.default ?? 0 });
  } else if (rule.type === "password") {
    control = h("input", { id, name, type: "password", autocomplete: "new-password", value: "" });
  } else if (rule.type === "email") {
    control = h("input", { id, name, type: "email", inputmode: "email", autocomplete: "off", value: value ?? "" });
  } else if (rule.type === "date") {
    control = h("input", { id, name, type: "date", value: value ?? (rule.required ? today() : "") });
  } else if (rule.type === "time") {
    control = h("input", { id, name, type: "time", value: timeOf(value) });
  } else {
    control = h("input", { id, name, type: "text", maxlength: rule.max, placeholder: rule.placeholder || "", value: value ?? "" });
  }

  if (control.tagName !== "DIV") {
    control.addEventListener("input", () => {
      state.dirty = true;
      error.hidden = true;
    });
  }
  form.controls[name] = control;

  return h("div", { class: "field", dataset: { field: name } }, [
    h("label", { for: id, text: rule.label + (rule.required ? " *" : "") }),
    control,
    hint,
    error,
  ]);
};

/** Groups consecutive short fields two-per-row so a phone still gets one column. */
const layoutFields = (fields, build) => {
  const blocks = [];
  let pair = [];
  const flush = () => {
    if (!pair.length) return;
    blocks.push(pair.length === 2 ? h("div", { class: "field-row" }, pair) : pair[0]);
    pair = [];
  };
  for (const [name, rule] of fields) {
    const wide = ["textarea", "media"].includes(rule.type);
    if (wide) {
      flush();
      blocks.push(build(name, rule));
    } else {
      pair.push(build(name, rule));
      if (pair.length === 2) flush();
    }
  }
  flush();
  return blocks;
};

const collectForm = (fields, form) => {
  const body = {};
  for (const [name, rule] of fields) {
    if (rule.type === "media") {
      body[name] = form.files[name] ?? null;
      continue;
    }
    const control = form.controls[name];
    if (control) body[name] = control.value;
  }
  if (body.published_at === "") body.published_at = today();
  return body;
};

const renderForm = async (resource, id) => {
  const seq = claimRender();
  const spec = RESOURCES[resource];
  const entitySchema = state.schema[spec.entity];
  const fetched = id ? (await api(`/${resource}?id=${encodeURIComponent(id)}`)).item : null;
  if (seq !== renderSeq) return;
  const item = fetched;
  // uuid-typed fields (album cover) are managed in the photo screen, not as text boxes.
  const fields = Object.entries(entitySchema.fields).filter(([, rule]) => rule.type !== "uuid");
  const form = {
    controls: {},
    files: item?.file_path ? { file: { path: item.file_path, name: item.file_name, mime: item.file_mime, bytes: item.file_bytes } } : {},
    fileFields: [],
  };

  const blocks = layoutFields(fields, (name, rule) =>
    field(name, rule, name === "file" ? form.files.file : item?.[name], form),
  );

  const save = async ({ goToList = true } = {}) => {
    const body = collectForm(fields, form);
    try {
      const saved = id
        ? await api(`/${resource}?id=${encodeURIComponent(id)}`, { method: "PATCH", body })
        : await api(`/${resource}`, { method: "POST", body });
      state.dirty = false;
      const published = body.status === "published" || item?.status === "published";
      toast(published ? "সংরক্ষিত হয়েছে এবং ওয়েবসাইটে প্রকাশিত।" : "খসড়া সংরক্ষিত হয়েছে — ওয়েবসাইটে এখনো দেখা যাচ্ছে না।");
      // A fresh album has no id to hang photos on while the form is open, so the
      // photo picker — the very next thing an admin needs — is opened for them right
      // after the save instead of leaving them to find the row's “ছবি” button.
      const toPhotos = !id && resource === "albums" && saved?.item?.id;
      if (goToList) location.hash = toPhotos ? `#/albums/${saved.item.id}/photos` : `#/${resource}`;
      return true;
    } catch (failure) {
      if (!(failure instanceof ApiError)) return false;
      showFieldErrors(failure);
      view.querySelector('[data-field] .err:not([hidden])')?.closest(".field")?.querySelector("input,select,textarea")?.focus();
      return false;
    }
  };

  const publishAfterSave = async () => {
    if (!(await save({ goToList: false }))) return;
    await api(`/${resource}?id=${encodeURIComponent(id)}&action=publish`, { method: "POST" });
    state.dirty = false;
    toast("প্রকাশিত হয়েছে — ওয়েবসাইটে দেখা যাচ্ছে।");
    location.hash = `#/${resource}`;
  };

  const formNode = h("form", { novalidate: true }, blocks);
  formNode.addEventListener("submit", (event) => {
    event.preventDefault();
    save();
  });

  view.replaceChildren(
    head(id ? `${spec.singular} সম্পাদনা` : spec.add.replace("+ ", ""), id ? null : spec.note, [
      h("a", { class: "btn btn-quiet", href: `#/${resource}` }, "তালিকায় ফিরুন"),
    ]),
    h("div", { class: "stack" }, [
      item?.status === "published"
        ? h("div", { class: "notice-line", dataset: { tone: "ok" } }, "এটি এখন ওয়েবসাইটে প্রকাশিত — সংরক্ষণ করলেই পরিবর্তন দেখা যাবে।")
        : h("div", { class: "notice-line" }, "খসড়া / অপ্রকাশিত অবস্থায় ওয়েবসাইটে কিছু দেখানো হবে না।"),
      h("div", { class: "card" }, formNode),
      h("div", { class: "form-foot" }, [
        h("button", { class: "btn", type: "submit", onclick: (event) => { event.preventDefault(); save(); } }, "সংরক্ষণ করুন"),
        id && item?.status !== "published" ? h("button", { class: "btn btn-gold", type: "button", onclick: publishAfterSave }, "সংরক্ষণ করে প্রকাশ করুন") : null,
        resource === "albums" && id ? h("a", { class: "btn btn-quiet", href: `#/albums/${id}/photos` }, "ছবি যোগ / ব্যবস্থাপনা") : null,
        h("span", { class: "spacer" }),
        h("a", { class: "btn btn-quiet", href: `#/${resource}` }, id ? "বাতিল" : "তালিকায় ফিরুন"),
      ]),
      h("p", { class: "hint", text: `ছবি বা PDF সংযুক্তি সর্বোচ্চ ${state.limits?.maxImageMb ?? 8} MB — তবে হোস্ট ${UPLOAD_HOST_LIMIT_MB} MB-এর বড় অনুরোধ বাতিল করে, তাই ${UPLOAD_FILE_LIMIT_MB} MB-এর বড় ফাইল আগে ছোট (২০০০ পিক্সেলের নিচে) করে নিন।` }),
    ]),
  );
  view.focus();
};

/* -------------------------------------------------- album + photo management */

const showFieldErrors = (failure) => {
  for (const [name, message] of Object.entries(failure.fields ?? {})) {
    const slot = view.querySelector(`[data-field="${name}"] .err`);
    if (slot) {
      slot.textContent = message;
      slot.hidden = false;
    }
  }
};

const renderAlbum = async (resource, id) => {
  const seq = claimRender();
  const fetchedAlbum = (await api(`/albums?id=${encodeURIComponent(id)}`)).item;
  if (seq !== renderSeq) return;
  const album = fetchedAlbum;
  const photos = album.photos ?? [];

  const picker = h("input", { id: "photoFiles", type: "file", accept: "image/jpeg,image/png,image/webp", multiple: true });
  const altDefault = h("input", { type: "text", placeholder: "বর্ণনা (alt) — সব ছবির জন্য (প্রযোজ্য হলে)", "aria-label": "ছবির বর্ণনা" });
  const bar = h("div", { class: "bar", hidden: true }, h("i", { style: "width:0%" }));
  const statusLine = h("p", { class: "hint", text: photoStatusHint(photos.length) });

  const doUpload = async () => {
    const files = [...(picker.files ?? [])];
    if (!files.length) return;
    const maxFiles = state.limits?.maxImagesPerUpload ?? 6;
    /* Whether a photo too big for a form request may go straight to storage is the
     * server's call, because it is the one that has to read the bytes back. If this
     * deployment cannot issue grants, the whole selection travels the form path exactly
     * as it did before. */
    let direct = directUploadsEnabled();
    let steps = planUploadSteps(files, { maxFiles, direct });
    const filesIn = (from) => steps.slice(from).flatMap((step) => (step.kind === "direct" ? [step.file] : step.batch));
    bar.hidden = false;
    bar.firstChild.style.width = "0%";
    let sent = 0;
    const added = [];
    const failed = [];

    const sendForm = async (batch, label) => {
      statusLine.textContent = `আপলোড হচ্ছে… ${label} · ছবি ${sent + 1}–${sent + batch.length}/${files.length}`;
      const data = new FormData();
      data.set("album_id", id);
      if (altDefault.value.trim()) data.set("alt_text", altDefault.value.trim());
      batch.forEach((file) => data.append("files", file, file.name));
      const payload = await uploadFiles(`/api/cms/photos?action=upload`, data, (percent) => (bar.firstChild.style.width = `${percent}%`));
      added.push(...(payload.photos ?? []));
      failed.push(...(payload.failed ?? []));
    };

    /* Allocate a staging key, PUT the bytes to it, then let the server read them back,
     * validate them and register the photo. The photo is in the album only after that
     * last step, so an interrupted transfer cannot leave a half-file attached to
     * anything, and a rejected one is deleted from staging on the way out. */
    const sendDirect = async (file, label) => {
      statusLine.textContent = `সরাসরি স্টোরেজে পাঠানো হচ্ছে… ${label} · ${file.name} (${uploadBytes(file)})`;
      const grant = await api("/photos?action=begin", { method: "POST", silent: true, body: { name: file.name, size: Number(file.size) || 0 } });
      if (!grant?.supported || !grant.staging_key) throw new DirectUnavailable(grant?.reason);
      let staging = grant.staging_key;
      try {
        await putToStorage(grant, file, (percent) => (bar.firstChild.style.width = `${Math.min(percent, 95)}%`));
        const alt = altDefault.value.trim();
        const payload = await api("/photos?action=commit", {
          method: "POST",
          silent: true,
          body: { album_id: id, staging_key: staging, name: file.name, ...(alt ? { alt } : {}) },
        });
        if (!payload?.photo) throw new ApiError("ছবিটি যোগ হয়েছে বলে নিশ্চিত করা যায়নি — আবার চাপুন।", 0);
        bar.firstChild.style.width = "100%";
        added.push(payload.photo);
        staging = null; // verified and registered; the server already emptied staging
      } finally {
        if (staging) await api("/photos?action=abort", { method: "POST", silent: true, body: { staging_key: staging } }).catch(() => null);
      }
    };

    try {
      let index = 0;
      while (index < steps.length) {
        const step = steps[index];
        const label = `অনুরোধ ${index + 1}/${steps.length}`;
        try {
          if (step.kind === "direct") await sendDirect(step.file, label);
          else await sendForm(step.batch, label);
        } catch (failure) {
          if (failure instanceof DirectUnavailable) {
            /* Storage said no — that is not the teacher's upload failing. This file and
             * the ones behind it go back on the form path; only a photo the host will
             * not carry in any arrangement is reported instead of fired at a wall. */
            direct = false;
            const remaining = filesIn(index);
            const carryable = [];
            for (const file of remaining) {
              if (file.size > UPLOAD_FILE_LIMIT_BYTES) failed.push({ name: file.name, message: `${uploadBytes(file)} ছবিটি হোস্টের ${UPLOAD_HOST_LIMIT_MB} MB সীমার বাইরে, এবং এই সার্ভারে সরাসরি আপলোড চালু নেই — আগে ছোট (২০০০ পিক্সেলের নিচে) করে নিন।` });
              else carryable.push(file);
            }
            steps = [...steps.slice(0, index), ...planUploadSteps(carryable, { maxFiles, direct: false })];
            if (index >= steps.length) break;
            continue;
          }
          /* A whole request refused by the host stores nothing, so the rest of the
           * selection is left on screen for a retry instead of being fired at the same
           * wall one after another. */
          statusLine.textContent = `আপলোড থেমে গেছে — ${failure.message} বাকি ${files.length - sent}টি ছবি এখনও পাঠানো হয়নি, আবার চাপুন।`;
          toast(failure.message, "danger");
          return;
        }
        sent += step.kind === "direct" ? 1 : step.batch.length;
        index += 1;
      }
      toast(
        failed.length
          ? `${added.length}টি ছবি যোগ হয়েছে; ${failed.length}টি বাদ পড়েছে: ${failed.map((f) => `${f.name}`).join(", ")}`
          : `${added.length}টি ছবি যোগ হয়েছে।`,
        failed.length ? "danger" : "ok",
      );
      if (!added.length && failed.length) statusLine.textContent = `কোনো ছবি যোগ হয়নি — ${failed[0].message}`;
      picker.value = "";
      route();
    } finally {
      bar.hidden = true;
    }
  };

  const photoCell = (photo, index) => {
    const alt = h("input", { type: "text", value: photo.alt_text || "", placeholder: "ছবির বর্ণনা (alt)", "aria-label": "ছবির বর্ণনা" });
    const caption = h("input", { type: "text", value: photo.caption || "", placeholder: "ক্যাপশন (ঐচ্ছিক)", "aria-label": "ক্যাপশন" });
    const saveBtn = h("button", {
      class: "btn btn-quiet btn-small",
      type: "button",
      onclick: async () => {
        await api("/photos?action=update", { method: "POST", body: { id: photo.id, alt_text: alt.value, caption: caption.value } });
        toast("ছবির তথ্য সংরক্ষিত।");
      },
    }, "সংরক্ষণ");
    return h("div", { class: "upload-cell" }, [
      h("img", { src: photo.thumb_url || photo.url, alt: "", loading: "lazy" }),
      h("p", { text: `${index + 1} · ${photo.bytes ? Math.round(photo.bytes / 1024) + " KB" : ""}` }),
      alt,
      caption,
      h("div", { class: "stack", style: "gap:.3rem" }, [
        saveBtn,
        h("div", { class: "view-actions" }, [
          h("button", { class: "btn btn-quiet btn-small", type: "button", disabled: index === 0, onclick: () => move(photo.id, "up") }, "↑"),
          h("button", { class: "btn btn-quiet btn-small", type: "button", disabled: index === photos.length - 1, onclick: () => move(photo.id, "down") }, "↓"),
          album.cover_photo_id === photo.id
            ? h("span", { class: "chip", dataset: { status: "info" }, text: "কভার" })
            : h("button", {
                class: "btn btn-quiet btn-small",
                type: "button",
                onclick: async () => {
                  await api(`/albums?id=${encodeURIComponent(id)}`, { method: "PATCH", body: { cover_photo_id: photo.id } });
                  toast("কভার ছবি পরিবর্তন হয়েছে।");
                  route();
                },
              }, "কভার করুন"),
        ]),
        h("div", { class: "view-actions" }, [
          h("button", {
            class: "btn btn-danger btn-small",
            type: "button",
            onclick: async () => {
              const yes = await confirmAction({ title: "ছবিটি সরান?", body: "ছবিটি বাতিল ঘরে যাবে; প্রয়োজনে ফিরিয়ে আনা যাবে।", yesLabel: "বাতিল ঘরে নিন" });
              if (!yes) return;
              await api("/photos?action=trash", { method: "POST", body: { id: photo.id } });
              toast("ছবিটি বাতিল ঘরে নেওয়া হয়েছে।");
              route();
            },
          }, "ছবি সরান"),
        ]),
      ]),
    ]);
  };

  const move = async (photoId, direction) => {
    await api("/photos?action=move", { method: "POST", body: { id: photoId, direction } });
    route();
  };

  picker.addEventListener("change", () => {
    const files = [...(picker.files ?? [])];
    if (!files.length) return;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    statusLine.textContent = `${files.length}টি ছবি নির্বাচিত (${Math.round(total / 1024 / 1024 * 10) / 10} MB)। “আপলোড” চাপুন।`;
  });

  view.replaceChildren(
    head(`ছবি: ${album.title}`, album.photo_count ? null : "ছবি যোগ করুন — মোবাইলের গ্যালারি থেকে সরাসরি বেছে নেওয়া যাবে।", [
      // An empty album cannot be published, so the button says so instead of failing later.
      album.status === "published"
        ? h("button", { class: "btn btn-quiet", type: "button", onclick: () => setStatus("albums", id, "unpublish") }, "ওয়েবসাইট থেকে সরান")
        : h("button", {
            class: "btn btn-gold",
            type: "button",
            disabled: !photos.length,
            title: photos.length ? "অ্যালবামটি ওয়েবসাইটে দেখানো হবে" : "আগে অন্তত একটি ছবি যোগ করুন",
            onclick: () => setStatus("albums", id, "publish"),
          }, "প্রকাশ করুন"),
      h("a", { class: "btn btn-quiet", href: "#/albums" }, "অ্যালবাম তালিকা"),
      h("a", { class: "btn btn-quiet", href: `#/albums/${id}` }, "অ্যালবামের তথ্য সম্পাদনা"),
    ]),
    h("div", { class: "stack" }, [
      h("div", { class: "notice-line", dataset: { tone: album.status === "published" ? "ok" : "" } },
        album.status === "published"
          ? "অ্যালবামটি প্রকাশিত — ওয়েবসাইটের গ্যালারিতে দেখা যাচ্ছে।"
          : `অ্যালবামটি ${STATUS_LABELS[album.status] ?? album.status} অবস্থায় আছে (ওয়েবসাইটে দেখানো হচ্ছে না)।`),
      h("div", { class: "card" }, [
        h("h2", { text: "ছবি আপলোড", style: "margin:0 0 .5rem;font-size:1rem" }),
        h("div", { class: "dropzone" }, [
          h("label", { for: "photoFiles", text: "ছবি বেছে নিন (একাধিক)" }),
          picker,
          altDefault,
          h("p", { text: photoLimitHint() }),
          h("div", { class: "view-actions" }, [
            h("button", { class: "btn", type: "button", onclick: doUpload }, "আপলোড করুন"),
            h("button", { class: "btn btn-quiet", type: "button", onclick: () => { picker.value = ""; statusLine.textContent = "নির্বাচন বাতিল।"; } }, "নির্বাচন বাতিল"),
          ]),
          bar,
        ]),
        statusLine,
      ]),
      photos.length
        ? h("div", { class: "card" }, [
            h("h2", { text: `যোগ হওয়া ছবি (${photos.length})`, style: "margin:0 0 .6rem;font-size:1rem" }),
            h("div", { class: "upload-grid" }, photos.map(photoCell)),
          ])
        : null,
    ]),
  );
  view.focus();
};

/* ------------------------------------------------------------------ accounts */

const renderAccounts = async () => {
  const seq = claimRender();
  const data = await api("/accounts");
  if (seq !== renderSeq) return;
  const createForm = { controls: {}, files: {}, fileFields: [] };
  const fields = Object.entries(state.schema.account.fields);
  const inputs = fields.map(([name, rule]) => field(name, rule, null, createForm));

  const submit = async () => {
    const body = {};
    for (const [name] of fields) {
      const control = createForm.controls[name];
      if (control) body[name] = control.value;
    }
    try {
      await api("/accounts", { method: "POST", body });
      toast("নতুন অ্যাকাউন্ট তৈরি হয়েছে। প্রথমবার লগইন করার পর পাসওয়ার্ড বদলানোর কথা মনে করিয়ে দিন।");
      route();
    } catch (failure) {
      if (failure instanceof ApiError) showFieldErrors(failure);
    }
  };

  view.replaceChildren(
    head("অ্যাকাউন্ট", "যে শিক্ষক/কর্মী ওয়েবসাইটের কনটেন্ট চালাবেন, তাঁদের অ্যাকাউন্ট এখানে। প্রত্যেয়ের পাসওয়ার্ড আলাদা — কারও সাথে শেয়ার করবেন না।"),
    h("div", { class: "stack" }, [
      h("div", { class: "rows" }, data.accounts.map((account) =>
        h("div", { class: "row" }, [
          h("div", { class: "row-main" }, [
            h("p", { class: "row-title", text: account.fullName }),
            h("p", { class: "row-meta" }, [
              h("span", { text: account.email }),
              h("span", { class: "chip", dataset: { status: account.isActive ? "published" : "unpublished" }, text: account.isActive ? "সক্রিয়" : "নিষ্ক্রিয়" }),
              h("span", { class: "chip", dataset: { status: "info" }, text: account.role === "admin" ? "অ্যাডমিন" : "স্টাফ" }),
              account.lastLoginAt ? h("span", { text: `শেষ প্রবেশ: ${new Date(account.lastLoginAt).toLocaleString("bn-BD")}` }) : null,
            ]),
          ]),
          h("div", { class: "row-foot" }, [
            h("button", {
              class: "btn btn-quiet btn-small",
              type: "button",
              onclick: async () => {
                const value = prompt("নতুন পাসওয়ার্ড লিখুন (অন্তত ১০ অক্ষর) — এই অ্যাকাউন্টের সব সেশন বন্ধ হয়ে যাবে।");
                if (!value) return;
                await api(`/accounts?id=${encodeURIComponent(account.id)}`, { method: "PATCH", body: { password: value } });
                toast("পাসওয়ার্ড বদলানো হয়েছে।");
              },
            }, "পাসওয়ার্ড বদল"),
            account.id !== state.me.id
              ? h("button", {
                  class: "btn btn-quiet btn-small",
                  type: "button",
                  onclick: async () => {
                    await api(`/accounts?id=${encodeURIComponent(account.id)}`, { method: "PATCH", body: { is_active: !account.isActive } });
                    toast(account.isActive ? "অ্যাকাউন্ট নিষ্ক্রিয় করা হয়েছে।" : "অ্যাকাউন্ট আবার সক্রিয়।");
                    route();
                  },
                }, account.isActive ? "নিষ্ক্রিয় করুন" : "সক্রিয় করুন")
              : null,
          ]),
        ]),
      )),
      h("div", { class: "card" }, [
        h("h2", { text: "নতুন অ্যাকাউন্ট যোগ করুন", style: "margin:0 0 .5rem;font-size:1rem" }),
        h("form", { novalidate: true }, inputs),
        h("button", { class: "btn", type: "button", style: "margin-top:.6rem", onclick: submit }, "যোগ করুন"),
      ]),
    ]),
  );
  view.focus();
};

const renderMyAccount = () => {
  const current = h("input", { type: "password", autocomplete: "current-password", id: "pwCurrent" });
  const next = h("input", { type: "password", autocomplete: "new-password", id: "pwNext" });
  const submit = async () => {
    try {
      await api("/password", { method: "POST", body: { current_password: current.value, new_password: next.value } });
      toast("পাসওয়ার্ড বদলে গেছে — এখন আবার প্রবেশ করুন।");
      state.me = null;
      showGate("login");
    } catch (failure) {
      if (failure instanceof ApiError) {
        for (const [name, message] of Object.entries(failure.fields ?? {})) {
          const target = name === "current_password" ? current : next;
          target.insertAdjacentText("afterend", "");
          toast(`${target === current ? "বর্তমান" : "নতুন"} পাসওয়ার্ড: ${message}`, "danger");
        }
      }
    }
  };
  view.replaceChildren(
    head("আমার অ্যাকাউন্ট", `${state.me.fullName} · ${state.me.email}`),
    h("div", { class: "stack" }, [
      h("div", { class: "card" }, [
        h("h2", { text: "পাসওয়ার্ড পরিবর্তন", style: "margin:0 0 .5rem;font-size:1rem" }),
        h("div", { class: "field" }, [h("label", { for: "pwCurrent", text: "বর্তমান পাসওয়ার্ড" }), current]),
        h("div", { class: "field" }, [h("label", { for: "pwNext", text: "নতুন পাসওয়ার্ড (অন্তত ১০ অক্ষর)" }), next]),
        h("button", { class: "btn", type: "button", style: "margin-top:.6rem", onclick: submit }, "পাসওয়ার্ড বদলান"),
        h("p", { class: "hint", text: "পরিবর্তনের পর সব ডিভাইস থেকে লগআউট হয়ে যাবে।" }),
      ]),
    ]),
  );
  view.focus();
};

/* --------------------------------------------------------------------- start */

const boot = async () => {
  const status = await api("/status", { silent: true }).catch(() => null);
  if (!status) {
    $("#gate").hidden = false;
    toast("সার্ভারের সাথে যোগাযোগ করা যায়নি।", "danger");
    return;
  }
  const session = await api("/session", { silent: true }).catch(() => null);
  if (session?.ok) {
    state.me = session.user;
    await enterApp();
    return;
  }
  if (status.needsSetup && status.setupUnlocked) showGate("setup");
  else showGate("login");
};

window.addEventListener("beforeunload", (event) => {
  if (state.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// Navigation inside the app clears the unsaved-changes flag.
window.addEventListener("hashchange", () => (state.dirty = false));

boot();
