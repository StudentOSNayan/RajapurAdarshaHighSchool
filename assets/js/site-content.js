/* Published content on the public pages.
 *
 * This script does not restyle anything. It fills the containers the templates
 * already declare (look for data-cms="…") with the school's published notices,
 * routines and photos, using the exact markup and class names the pages already
 * use — so a card from the CMS is indistinguishable from a card in the HTML.
 *
 * Behaviour rules:
 *   - any container stays exactly as authored when the CMS has nothing to show
 *     (no rows, API not configured, offline, first visit before the fetch lands);
 *   - only rows whose status is published are ever returned by /api/public/*,
 *     so a draft cannot appear here even if this file is tampered with;
 *   - all database text is inserted as text nodes, never as HTML, so stored
 *     content can not inject markup;
 *   - the file is `defer`red and adds no render-blocking work, and it makes no
 *     request at all on pages that declare no data-cms container.
 */

(() => {
  "use strict";

  const ENDPOINT = "/api/public/";
  const containers = new Map();
  for (const node of document.querySelectorAll("[data-cms]")) {
    const key = node.dataset.cms;
    if (!containers.has(key)) containers.set(key, []);
    containers.get(key).push(node);
  }
  if (!containers.size) return;

  /* ------------------------------------------------------------- utilities */

  const fetchJson = async (path) => {
    try {
      const response = await fetch(`${ENDPOINT}${path}`, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) return null;
      const payload = await response.json();
      return payload && payload.ok ? payload : null;
    } catch {
      return null;
    }
  };

  /** Icons copied from the pages themselves, so the SVGs stay byte-identical. */
  const iconFrom = (selector) => {
    const source = document.querySelector(selector);
    return source ? source.cloneNode(true) : null;
  };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  const withIcon = (icon, label) => {
    const slot = el("span");
    if (icon) slot.append(icon.cloneNode(true));
    slot.append(document.createTextNode(label));
    return slot;
  };

  /** The date/place line under a card, built from { icon, text } entries. */
  const metaLine = (items) => {
    const details = el("div", "notice-details");
    for (const item of items) {
      if (item && item.text) details.append(withIcon(item.icon, item.text));
    }
    return details;
  };

  const attachment = (file) => {
    if (!file || !file.url) return null;
    const link = el("a", "text-link", `${file.name || "সংযুক্ত নথি"} ডাউনলোড`);
    link.href = file.url;
    link.setAttribute("download", "");
    link.rel = "noopener";
    return link;
  };

  /** One notice-style card, in the same shape the page already uses. */
  const card = ({ title, tags = [], body, details, primary = false, file }) => {
    const article = el("article", `notice-card${primary ? " primary-notice" : ""}`);
    if (tags.length) {
      const meta = el("div", "meta-row");
      for (const tag of tags) meta.append(el("span", tag.gold ? "tag gold" : "tag", tag.label));
      article.append(meta);
    }
    article.append(el("h3", null, title));
    if (body) article.append(el("p", "small-copy", body));
    if (details && details.children.length) article.append(details);
    const link = attachment(file);
    if (link) article.append(link);
    return article;
  };

  const paragraphs = (value) =>
    String(value || "")
      .split(/\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter(Boolean);

  /* --------------------------------------------------------------- notices */

  const ICONS = {
    // Fallbacks, in case a page has no existing example to clone from.
    calendar: null,
    clock: null,
  };

  const noticeTypeLabel = (type) =>
    ({ general: "নোটিশ", exam: "পরীক্ষা", result: "ফলাফল", admission: "ভর্তি", event: "অনুষ্ঠান", emergency: "জরুরি" })[type] || "নোটিশ";

  /* One card builder per list, so the first page and an older page are never two
   * different shapes of markup. They use the page's own card, byte for byte. */

  const noticeCard = (row, index) =>
    card({
      title: row.title,
      tags: [{ label: "অফিশিয়াল নোটিশ", gold: true }, { label: noticeTypeLabel(row.type) }],
      body: paragraphs(row.body).join(" "),
      details: metaLine([
        { icon: ICONS.calendar, text: row.date_label },
        { icon: ICONS.clock, text: row.audience },
      ]),
      primary: row.importance === "urgent" && index === 0,
      file: row.file,
    });

  const examCard = (row) =>
    card({
      title: row.exam_name,
      tags: [
        { label: row.class_name, gold: true },
        { label: row.subject },
      ],
      body: row.notes || null,
      details: metaLine([
        { icon: ICONS.calendar, text: row.date_label },
        { icon: ICONS.clock, text: row.time },
        { icon: ICONS.clock, text: row.room },
      ]),
      file: row.file,
    });

  const routineCard = (row) => {
    const time = [row.start_time, row.end_time].filter(Boolean).join(" – ");
    return card({
      title: row.title,
      tags: [{ label: row.routine_type, gold: true }, row.class_name ? { label: row.class_name } : null].filter(Boolean),
      body: row.description,
      details: metaLine([
        { icon: ICONS.calendar, text: row.date_label },
        { icon: ICONS.clock, text: time },
      ]),
      file: row.file,
    });
  };

  /* --------------------------------------------------------- paged list feeds */

  /**
   * Notices, exam routines and other routines all grow over time, and their feed answers
   * a page at a time. These are the rules that make that safe for a school:
   *
   *   - the first page takes over its container the way it always did. The notice written
   *     into notices.html is the zero-state stand-in, so it stays on screen untouched while
   *     the CMS has nothing published;
   *   - every page after the first is ADDED, never a replacement. Older notices go below
   *     and earlier exam rows go above, because each list keeps its own ordering rule — the
   *     newest item is always at the top of what is visible, and nothing already on screen
   *     is moved, hidden or dropped;
   *   - a card this script inserts carries data-cms-record="<row id>", and a page whose id
   *     is already on the page is skipped. So a double click, a retried request, or this
   *     file being evaluated twice cannot show one notice twice;
   *   - a failed request leaves the page exactly as it was and keeps the control for a retry.
   *
   * Nothing here deletes or hides a published row. A record that is not on this page is one
   * click away, and the control only exists while there is more to load.
   */
  const LIST_FEEDS = {
    notices: { feed: "notices", rows: "notices", card: noticeCard, older: "আরও পুরোনো নোটিশ দেখুন", place: "after" },
    "exam-routines": { feed: "exams", rows: "exams", card: examCard, older: "আগের রুটিন দেখুন", place: "before" },
    routines: { feed: "routines", rows: "routines", card: routineCard, older: "আরও পুরোনো রুটিন দেখুন", place: "after" },
  };

  const listStates = new Map();

  const listState = (list) => {
    let state = listStates.get(list);
    if (!state) {
      state = { seen: new Set(), limit: 0, offset: null, hasMore: false, loading: false, control: null };
      listStates.set(list, state);
    }
    return state;
  };

  /** Forgets a list completely — what happens when its feed turns out to be empty. */
  const resetList = (list) => {
    const state = listState(list);
    if (state.control) {
      state.control.remove();
      state.control = null;
    }
    state.seen.clear();
    state.limit = 0;
    state.offset = null;
    state.hasMore = false;
    state.loading = false;
    list.replaceChildren();
  };

  const paintPage = (list, feed, payload, { replace }) => {
    const spec = LIST_FEEDS[feed];
    const state = listState(list);
    const rows = payload[spec.rows] || [];
    if (replace) {
      list.replaceChildren();
      state.seen.clear();
    }
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const id = String(row.id ?? "");
      if (!id || state.seen.has(id)) continue; // one card per published row, always
      state.seen.add(id);
      const node = spec.card(row, state.seen.size - 1);
      node.dataset.cmsRecord = id;
      fragment.append(node);
    }
    if (spec.place === "before" && state.control) list.insertBefore(fragment, state.control);
    else if (spec.place === "before") list.prepend(fragment);
    else list.append(fragment);
    state.limit = Number(payload.limit) || rows.length;
    state.offset = payload.next_offset ?? null;
    state.hasMore = payload.has_more === true && state.offset !== null;
  };

  /**
   * The control is a plain button in the site's own button style, placed inside the list so
   * the grid gap that already separates cards spaces it too — no new CSS, no new markup in
   * the HTML, and on a phone it is a full-width row rather than a floating chip.
   */
  const drawOlder = (list, feed) => {
    const spec = LIST_FEEDS[feed];
    const state = listState(list);
    if (!state.hasMore) {
      if (state.control) {
        state.control.remove();
        state.control = null;
      }
      return;
    }
    if (!state.control) {
      // The list's own size scale, and .btn's 45px box, so the control is a real tap
      // target on a phone rather than a 39px chip.
      const button = el("button", "btn btn-outline", spec.older);
      button.type = "button";
      button.dataset.cmsMore = feed;
      button.addEventListener("click", () => loadOlder(list, feed));
      state.control = button;
    }
    state.control.disabled = false;
    state.control.textContent = spec.older;
    if (spec.place === "before") list.prepend(state.control);
    else list.append(state.control);
  };

  const loadOlder = async (list, feed) => {
    const spec = LIST_FEEDS[feed];
    const state = listState(list);
    if (state.loading || !state.hasMore || state.offset === null) return;
    state.loading = true;
    if (state.control) {
      state.control.disabled = true;
      state.control.textContent = "লোড হচ্ছে…";
    }
    list.setAttribute("aria-busy", "true");
    const payload = await fetchJson(`${spec.feed}?limit=${state.limit}&offset=${state.offset}`);
    list.removeAttribute("aria-busy");
    state.loading = false;
    if (payload) paintPage(list, feed, payload, { replace: false });
    drawOlder(list, feed);
  };

  const renderNotices = (payload) => {
    const rows = payload.notices || [];
    if (!rows.length) return;
    ICONS.calendar = iconFrom(".notice-details span svg");
    ICONS.clock = iconFrom(".notice-details span + span svg") || ICONS.calendar;

    for (const list of containers.get("notices") || []) {
      paintPage(list, "notices", payload, { replace: true });
      drawOlder(list, "notices");
    }

    // The homepage strip mirrors the newest published notice, and only that one.
    const strip = (containers.get("home-notice") || [])[0];
    if (strip) {
      const latest = rows[0];
      const text = strip.querySelector(".home-notice-text");
      if (text) text.textContent = latest.title;
      const meta = strip.querySelector(".home-notice-meta");
      if (meta && latest) {
        meta.replaceChildren(
          withIcon(ICONS.calendar, latest.date_label || ""),
          latest.audience ? withIcon(ICONS.clock, latest.audience) : null,
        );
      }
    }
  };

  /* --------------------------------------------------------------- routines */

  const renderExamRoutines = (payload) => {
    const section = document.getElementById("exam-routines");
    if (!section) return;
    const list = (containers.get("exam-routines") || [])[0];
    if (!list) return;
    if (!payload.exams || !payload.exams.length) {
      resetList(list);
      section.hidden = true;
      return;
    }
    section.hidden = false;
    paintPage(list, "exam-routines", payload, { replace: true });
    drawOlder(list, "exam-routines");
  };

  const renderRoutines = (payload) => {
    const section = document.getElementById("school-routines");
    if (!section) return;
    const list = (containers.get("routines") || [])[0];
    if (!list) return;
    if (!payload.routines || !payload.routines.length) {
      resetList(list);
      section.hidden = true;
      return;
    }
    section.hidden = false;
    paintPage(list, "routines", payload, { replace: true });
    drawOlder(list, "routines");
  };

  /* ---------------------------------------------------------------- gallery */

  /**
   * Photos are written in the same `article > button` shape the curated gallery
   * uses, so the existing filter buttons and the lightbox keep working — main.js
   * re-scans after the `site-content:gallery` event below.
   *
   * Published photos are ADDED to the grid and to the home strip; they never
   * substitute for it. The tiles in the HTML are the school's own pictures and are
   * left exactly as authored. Each inserted tile carries data-cms-photo="<photo id>"
   * so a re-render removes only what this function put there — the same photo can
   * never be added twice and the count cannot drift, whatever else is on the page.
   */
  const dropCmsTiles = (container) => {
    for (const tile of container.querySelectorAll("[data-cms-photo]")) tile.remove();
  };

  const renderGallery = (albums) => {
    const grid = (containers.get("gallery") || [])[0];
    const strip = (containers.get("photo-strip") || [])[0];
    const flat = [];
    const seen = new Set();
    for (const album of albums || []) {
      for (const photo of album.photos || []) {
        if (!photo.id || seen.has(photo.id)) continue; // one tile per photo, always
        seen.add(photo.id);
        flat.push({ ...photo, album });
      }
    }

    if (grid) {
      dropCmsTiles(grid);
      if (flat.length) {
        const fragment = document.createDocumentFragment();
        for (const photo of flat) {
          const item = el("article", "gallery-item");
          item.dataset.galleryItem = "";
          item.dataset.cmsPhoto = photo.id;
          if (photo.album.category) item.dataset.tags = photo.album.category;
          const trigger = el("button", "gallery-card");
          trigger.type = "button";
          trigger.dataset.galleryOpen = "";
          trigger.dataset.image = photo.full;
          trigger.dataset.alt = photo.alt || photo.album.title;
          trigger.dataset.title = photo.caption || photo.album.title;
          trigger.dataset.description = [photo.album.title, photo.album.date_label].filter(Boolean).join(" · ");
          trigger.setAttribute("aria-label", `ছবি খুলুন: ${photo.caption || photo.album.title}`);
          const wrap = el("span", "gallery-image-wrap");
          const image = el("img");
          image.setAttribute("src", photo.thumb);
          image.setAttribute("alt", photo.alt || photo.album.title);
          image.setAttribute("width", String(photo.width || 1200));
          image.setAttribute("height", String(photo.height || 900));
          image.setAttribute("loading", "lazy");
          image.setAttribute("decoding", "async");
          wrap.append(image);
          const caption = el("span", "gallery-card-caption");
          caption.append(el("strong", null, photo.caption || photo.album.title));
          const tags = el("span", "gallery-tags");
          for (const label of [photo.album.category_label, photo.album.date_label].filter(Boolean)) tags.append(el("span", "tag", label));
          caption.append(tags);
          trigger.append(wrap, caption);
          item.append(trigger);
          fragment.append(item);
        }
        grid.append(fragment);
      }
      /* Whether the feed added tiles or had nothing to add, the page re-counts and
       * re-filters: curated tiles keep their authored place either way. */
      document.dispatchEvent(new CustomEvent("site-content:gallery"));
    }

    if (strip) {
      dropCmsTiles(strip);
      if (flat.length) {
        const fragment = document.createDocumentFragment();
        for (const photo of flat.slice(0, 4)) {
          const link = el("a");
          link.href = "gallery.html";
          link.dataset.cmsPhoto = photo.id;
          link.setAttribute("aria-label", `গ্যালারি খুলুন: ${photo.caption || photo.album.title}`);
          const image = el("img");
          image.setAttribute("src", photo.thumb);
          image.setAttribute("alt", photo.alt || photo.album.title);
          image.setAttribute("width", String(photo.width || 1200));
          image.setAttribute("height", String(photo.height || 900));
          image.setAttribute("loading", "lazy");
          image.setAttribute("decoding", "async");
          link.append(image);
          fragment.append(link);
        }
        strip.append(fragment);
      }
    }
  };

  const CATEGORY_LABELS = {
    campus: "ক্যাম্পাস",
    sports: "খেলাধুলা",
    programs: "অনুষ্ঠান",
    tours: "শিক্ষা সফর",
    tree: "বৃক্ষরোপণ",
    activities: "কার্যক্রম",
  };

  /* ------------------------------------------------------------------- boot */

  const run = async () => {
    const wanted = {
      notices: containers.has("notices") || containers.has("home-notice"),
      exams: containers.has("exam-routines"),
      routines: containers.has("routines"),
      gallery: containers.has("gallery") || containers.has("photo-strip"),
    };
    ICONS.calendar = iconFrom(".notice-details span svg");
    ICONS.clock = iconFrom(".notice-details span + span svg") || ICONS.calendar;
    const jobs = [];
    if (wanted.notices) {
      jobs.push(
        fetchJson("notices").then((payload) => {
          if (payload) renderNotices(payload);
        }),
      );
    }
    if (wanted.exams) {
      jobs.push(
        fetchJson("exams").then((payload) => {
          if (payload) renderExamRoutines(payload);
        }),
      );
    }
    if (wanted.routines) {
      jobs.push(
        fetchJson("routines").then((payload) => {
          if (payload) renderRoutines(payload);
        }),
      );
    }
    if (wanted.gallery) {
      jobs.push(
        fetchJson("gallery?albums=24&per_album=12").then((payload) => {
          if (!payload) return;
          for (const album of payload.albums || []) album.category_label = CATEGORY_LABELS[album.category] || null;
          renderGallery(payload.albums);
        }),
      );
    }
    await Promise.all(jobs);
    document.documentElement.classList.add("cms-ready");
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
})();
