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

  const renderNotices = (rows) => {
    if (!rows || !rows.length) return;
    ICONS.calendar = iconFrom(".notice-details span svg");
    ICONS.clock = iconFrom(".notice-details span + span svg") || ICONS.calendar;

    for (const list of containers.get("notices") || []) {
      const fragment = document.createDocumentFragment();
      rows.forEach((row, index) => {
        fragment.append(
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
          }),
        );
      });
      list.replaceChildren(fragment);
    }

    // The homepage strip mirrors the newest published notice.
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

  const noticeTypeLabel = (type) =>
    ({ general: "নোটিশ", exam: "পরীক্ষা", result: "ফলাফল", admission: "ভর্তি", event: "অনুষ্ঠান", emergency: "জরুরি" })[type] || "নোটিশ";

  /* --------------------------------------------------------------- routines */

  const renderExamRoutines = (rows) => {
    const section = document.getElementById("exam-routines");
    if (!section) return;
    const list = (containers.get("exam-routines") || [])[0];
    if (!list) return;
    if (!rows || !rows.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      fragment.append(
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
        }),
      );
    }
    list.replaceChildren(fragment);
  };

  const renderRoutines = (rows) => {
    const section = document.getElementById("school-routines");
    if (!section) return;
    const list = (containers.get("routines") || [])[0];
    if (!list) return;
    if (!rows || !rows.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const time = [row.start_time, row.end_time].filter(Boolean).join(" – ");
      fragment.append(
        card({
          title: row.title,
          tags: [{ label: row.routine_type, gold: true }, row.class_name ? { label: row.class_name } : null].filter(Boolean),
          body: row.description,
          details: metaLine([
            { icon: ICONS.calendar, text: row.date_label },
            { icon: ICONS.clock, text: time },
          ]),
          file: row.file,
        }),
      );
    }
    list.replaceChildren(fragment);
  };

  /* ---------------------------------------------------------------- gallery */

  /**
   * Photos are written in the same `article > button` shape the curated gallery
   * uses, so the existing filter buttons and the lightbox keep working — main.js
   * re-scans after the `site-content:gallery` event below.
   */
  const renderGallery = (albums) => {
    const grid = (containers.get("gallery") || [])[0];
    const strip = (containers.get("photo-strip") || [])[0];
    const flat = [];
    for (const album of albums || []) {
      for (const photo of album.photos || []) {
        flat.push({ ...photo, album });
      }
    }

    if (grid) {
      if (flat.length) {
        const fragment = document.createDocumentFragment();
        for (const photo of flat) {
          const item = el("article", "gallery-item");
          item.dataset.galleryItem = "";
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
        grid.replaceChildren(fragment);
        document.dispatchEvent(new CustomEvent("site-content:gallery"));
      }
      /* With no published photo the curated grid in the page is left untouched. */
    }

    if (strip && flat.length) {
      const fragment = document.createDocumentFragment();
      for (const photo of flat.slice(0, 4)) {
        const link = el("a");
        link.href = "gallery.html";
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
      strip.replaceChildren(fragment);
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
          if (payload) renderNotices(payload.notices);
        }),
      );
    }
    if (wanted.exams) {
      jobs.push(
        fetchJson("exams").then((payload) => {
          if (payload) renderExamRoutines(payload.exams);
        }),
      );
    }
    if (wanted.routines) {
      jobs.push(
        fetchJson("routines").then((payload) => {
          if (payload) renderRoutines(payload.routines);
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
