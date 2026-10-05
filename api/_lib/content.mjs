/* Content operations: the only place that knows how a notice / routine / album /
 * photo row is created, published, trashed and read back.
 *
 * Both the admin API and the public feeds go through this module, so the
 * draft-vs-published rule cannot be bypassed by calling one of them directly.
 */

import { config } from "./config.mjs";
import { badRequest, notFound } from "./http.mjs";
import { getStore } from "./db.mjs";
import { ENTITIES } from "./db.mjs";
import { validate, toBengaliDate } from "./validate.mjs";
import { assertMediaExists, deleteMedia, fileMeta, mediaUrl, thumbTransform } from "./media.mjs";

export const RESOURCES = {
  notices: {
    table: "notices",
    entity: "notice",
    label: "নোটিশ",
    publicPage: 20,
    publicMax: 100,
    adminOrder: [{ col: "published_at", dir: "desc", nullsLast: true }, { col: "updated_at", dir: "desc" }],
    publicOrder: [{ col: "published_at", dir: "desc" }, { col: "created_at", dir: "desc" }],
    search: ["title", "body", "audience"],
    dateField: "published_at",
  },
  exams: {
    table: "exam_routines",
    entity: "exam",
    label: "পরীক্ষার রুটিন",
    publicPage: 200,
    publicMax: 200,
    // Displayed oldest-date-first, so the window is anchored at the newest row: a
    // 201st published exam would otherwise be cut off the bottom of the table.
    publicTail: true,
    adminOrder: [{ col: "exam_date", dir: "desc" }, { col: "sort_order", dir: "asc" }],
    publicOrder: [{ col: "exam_date", dir: "asc" }, { col: "sort_order", dir: "asc" }, { col: "start_time", dir: "asc", nullsFirst: false }],
    search: ["exam_name", "class_name", "subject", "room"],
    dateField: "exam_date",
  },
  routines: {
    table: "routines",
    entity: "routine",
    label: "রুটিন",
    publicPage: 40,
    publicMax: 100,
    adminOrder: [{ col: "updated_at", dir: "desc" }],
    publicOrder: [{ col: "event_date", dir: "desc", nullsFirst: false }, { col: "created_at", dir: "desc" }],
    search: ["title", "routine_type", "class_name", "description"],
    dateField: "event_date",
  },
  albums: {
    table: "albums",
    entity: "album",
    label: "অ্যালবাম",
    adminOrder: [{ col: "updated_at", dir: "desc" }],
    publicOrder: [{ col: "album_date", dir: "desc", nullsFirst: false }, { col: "created_at", dir: "desc" }],
    search: ["title", "description", "category"],
    dateField: "album_date",
  },
};

const resourceOf = (name) => {
  const spec = RESOURCES[name];
  if (!spec) throw notFound(`অজানা কনটেন্ট টাইপ: ${name}`);
  return spec;
};

const audit = (store, actor, action, table, id, detail = null) =>
  store.audit
    .add({ user_id: actor?.user?.id ?? null, user_email: actor?.user?.email ?? null, action, entity: table, entity_id: id ? String(id) : null, detail })
    .catch(() => null);

/* --------------------------------------------------------------- admin CRUD */

export async function listForAdmin(name, { status, search, deleted = false, limit = 100, offset = 0 } = {}) {
  const spec = resourceOf(name);
  const store = await getStore();
  const where = [];
  if (status) where.push({ col: "status", op: "eq", value: status });
  if (search) {
    // PostgREST would need OR=; keeping one simple LIKE per call is enough at school scale.
    where.push({ col: spec.search[0], op: "like", value: search });
  }
  const rows = await store.rawList(spec.table, {
    where: deleted
      ? [{ col: "deleted_at", op: "is_not", value: null }]
      : [...where, { col: "deleted_at", op: "is", value: null }],
    order: spec.adminOrder,
    limit,
    offset,
  });
  let shaped = rows.map((row) => shapeAdminRow(name, row));
  if (search && spec.search.length > 1) {
    const needle = String(search).toLowerCase();
    shaped = shaped.filter((row) => spec.search.some((field) => String(row[field] ?? "").toLowerCase().includes(needle)));
  }
  if (name === "albums") shaped = await withPhotoCounts(shaped);
  return shaped;
}

const shapeAdminRow = (name, row) => {
  const base = { ...row, date_label: toBengaliDate(row[RESOURCES[name].dateField]) };
  if (row.file_path) base.file = fileMeta(row);
  return base;
};

const withPhotoCounts = async (albums) => {
  if (!albums.length) return albums;
  const store = await getStore();
  const ids = albums.map((album) => album.id);
  const photos = await store.rawList("photos", {
    where: [{ col: "album_id", op: "in", value: ids }, { col: "deleted_at", op: "is", value: null }],
    order: [{ col: "sort_order", dir: "asc" }, { col: "created_at", dir: "asc" }],
    select: PUBLIC_SELECT.photos,
  });
  const grouped = new Map();
  for (const photo of photos) {
    const list = grouped.get(photo.album_id) ?? [];
    list.push(photo);
    grouped.set(photo.album_id, list);
  }
  return albums.map((album) => {
    const list = grouped.get(album.id) ?? [];
    return {
      ...album,
      photo_count: list.length,
      cover_url: mediaUrl((list.find((p) => p.id === album.cover_photo_id) ?? list[0])?.file_path, thumbTransform()),
      cover_full_url: mediaUrl((list.find((p) => p.id === album.cover_photo_id) ?? list[0])?.file_path),
      photos: list.map((photo) => shapePhoto(photo)),
    };
  });
};

export const shapePhoto = (photo) => ({
  id: photo.id,
  album_id: photo.album_id,
  alt_text: photo.alt_text || "",
  caption: photo.caption || "",
  bytes: photo.bytes ?? null,
  mime: photo.mime ?? null,
  pixel_width: photo.pixel_width ?? null,
  pixel_height: photo.pixel_height ?? null,
  sort_order: photo.sort_order ?? 0,
  created_at: photo.created_at,
  url: mediaUrl(photo.file_path),
  thumb_url: mediaUrl(photo.file_path, thumbTransform()),
});

export async function readOne(name, id) {
  const spec = resourceOf(name);
  const store = await getStore();
  const row = await store.byId(spec.table, id, { includeDeleted: true });
  if (spec.table === "albums") {
    const [withCount] = await withPhotoCounts([row]);
    return withCount;
  }
  return shapeAdminRow(name, row);
}

export async function create(name, payload, actor) {
  const spec = resourceOf(name);
  const store = await getStore();
  const clean = validate(spec.entity, payload);
  if (clean.status === "published") await assertPublishable(spec, clean, store);
  if (clean.file_path) await assertMediaExists(clean.file_path);
  if (clean.cover_photo_id) await assertCoverBelongsToAlbum(spec, null, clean.cover_photo_id, store);
  const created = await store.insert(spec.table, { ...clean, created_by: actor.user.id, updated_by: actor.user.id });
  await audit(store, actor, "create", spec.table, created.id, clean.title ?? clean.exam_name ?? null);
  return shapeAdminRow(name, created);
}

export async function update(name, id, payload, actor) {
  const spec = resourceOf(name);
  const store = await getStore();
  const existing = await store.byId(spec.table, id);
  const clean = validate(spec.entity, payload, { partial: true });
  const merged = { ...existing, ...clean };
  if (clean.status === "published" || (merged.status === "published" && "status" in clean)) {
    await assertPublishable(spec, merged, store);
  }
  // An edit only edits the row. Clearing or swapping an attachment leaves the previous
  // object in storage, because an edit is not a delete: a card already cached by a
  // visitor, or another row that happens to share the key, would otherwise lose its file
  // mid-air with nothing in the trash to put it back. Purge is the way to free bytes.
  if (clean.file_path) await assertMediaExists(clean.file_path);
  if ("cover_photo_id" in clean) await assertCoverBelongsToAlbum(spec, id, clean.cover_photo_id, store);
  const updated = await store.update(spec.table, id, { ...clean, updated_by: actor.user.id });
  await audit(store, actor, "update", spec.table, id, null);
  return shapeAdminRow(name, updated);
}

export async function setStatus(name, id, status, actor) {
  const spec = resourceOf(name);
  if (!["draft", "published", "unpublished"].includes(status)) throw badRequest("অবস্থা সঠিক নয়।");
  const store = await getStore();
  const existing = await store.byId(spec.table, id);
  if (status === "published") {
    await assertPublishable(spec, existing, store, id);
    if (!existing.published_at) throw badRequest("প্রকাশের আগে তারিখ নির্ধারণ করুন।", { published_at: "তারিখ দিন।" });
  }
  const updated = await store.update(spec.table, id, { status, updated_by: actor.user.id });
  await audit(store, actor, status === "published" ? "publish" : "unpublish", spec.table, id, null);
  return shapeAdminRow(name, updated);
}

/** A cover must be a photo of that very album, never an arbitrary id. */
const assertCoverBelongsToAlbum = async (spec, albumId, photoId, store) => {
  if (spec.table !== "albums" || !photoId) return;
  const photo = await store.one("photos", [{ col: "id", op: "eq", value: photoId }, NOT_DELETED]);
  if (!photo || (albumId && photo.album_id !== albumId)) {
    throw badRequest("কভার ছবিটি এই অ্যালবামের নয়।", { cover_photo_id: "নিজের অ্যালবামের ছবি বেছে নিন।" });
  }
};

/** "Published content should have the required information" — enforced at the door. */
const assertPublishable = async (spec, row, store, id = null) => {
  if (spec.table !== "albums") return;
  const albumId = id ?? row.id;
  const photos = await store.rawList("photos", {
    where: [{ col: "album_id", op: "eq", value: albumId }, { col: "deleted_at", op: "is", value: null }],
    select: ["id"],
  });
  if (!photos.length) {
    throw badRequest("অ্যালবামে অন্তত একটি ছবি থাকলে তবেই প্রকাশ করা যাবে।", { status: "প্রথমে ছবি যোগ করুন।" });
  }
};

/* Objects live in one bucket and many kinds of row can name one, so a purge asks first
 * whether anything still points at the bytes before removing them. The tables are scanned
 * without a status or deleted_at filter on purpose: a draft, or a row sitting in the trash
 * waiting to be restored, is still a reason to keep a file.
 */
const MEDIA_HOLDERS = ["notices", "exam_routines", "routines", "photos"];

const stillReferenced = async (store, key) => {
  for (const table of MEDIA_HOLDERS) {
    const rows = await store
      .rawList(table, { where: [{ col: "file_path", op: "eq", value: key }], select: ["id"], limit: 1 })
      .catch(() => []);
    if (rows.length) return true;
  }
  return false;
};

/** Frees the objects nothing points at any more, and says how many went. */
const releaseMedia = async (store, paths) => {
  let removed = 0;
  for (const pathValue of paths.filter(Boolean)) {
    if (await stillReferenced(store, pathValue)) continue;
    await deleteMedia(pathValue);
    removed += 1;
  }
  return removed;
};

/* --------------------------------------------------------- trash and purge */

export async function trash(name, id, actor) {
  const spec = resourceOf(name);
  const store = await getStore();
  const row = await store.byId(spec.table, id);
  await store.softDelete(spec.table, id);
  await audit(store, actor, "trash", spec.table, id, row.title ?? row.exam_name ?? null);
  return { ok: true, trashed: true };
}

export async function restore(name, id, actor) {
  const spec = resourceOf(name);
  const store = await getStore();
  await store.byId(spec.table, id, { includeDeleted: true });
  await store.restore(spec.table, id);
  await audit(store, actor, "restore", spec.table, id, null);
  return { ok: true };
}

/**
 * Permanent delete. Requires an explicit confirmation word from the admin app and is the
 * only place that frees stored bytes — this is the step the school chose when it typed
 * DELETE, so the files go with the row, except where another row still names the same
 * object. Photos in a trashed album are purged with it.
 */
export async function purge(name, id, actor, { confirm } = {}) {
  const spec = resourceOf(name);
  if (confirm !== "DELETE") throw badRequest("মুছে ফেলার জন্য নিশ্চিতকরণ প্রয়োজন।", { confirm: "‘DELETE’ লিখে নিশ্চিত করুন।" });
  const store = await getStore();
  const row = await store.byId(spec.table, id, { includeDeleted: true });

  const paths = [];
  if (row.file_path) paths.push(row.file_path);
  if (spec.table === "albums") {
    const photos = await store.rawList("photos", {
      where: [{ col: "album_id", op: "eq", value: id }],
      select: ["id", "file_path"],
    });
    paths.push(...photos.map((photo) => photo.file_path).filter(Boolean));
    for (const photo of photos) await store.driver.remove("photos", photo.id).catch(() => null);
  }
  await store.purge(spec.table, id);
  const removed = await releaseMedia(store, paths);
  await audit(store, actor, "purge", spec.table, id, `${removed ? removed + " টি ফাইলসহ" : ""}`);
  // filesRemoved is what actually went; filesKept is a row elsewhere still naming the object.
  return { ok: true, purged: true, filesRemoved: removed, filesKept: paths.length - removed };
}

/* ------------------------------------------------------------------- photos */

export async function addPhotoRecord(albumId, record, actor) {
  const store = await getStore();
  await store.byId("albums", albumId);
  const siblings = await store.rawList("photos", {
    where: [{ col: "album_id", op: "eq", value: albumId }, { col: "deleted_at", op: "is", value: null }],
    select: ["id"],
  });
  const created = await store.insert("photos", {
    album_id: albumId,
    file_path: record.path,
    alt_text: record.alt || null,
    caption: record.caption || null,
    bytes: record.bytes ?? null,
    mime: record.mime ?? null,
    pixel_width: record.width ?? null,
    pixel_height: record.height ?? null,
    sort_order: siblings.length + (record.offset ?? 0),
    created_by: actor.user.id,
  });
  const albums = await store.byId("albums", albumId);
  if (!albums.cover_photo_id) {
    await store.update("albums", albumId, { cover_photo_id: created.id }).catch(() => null);
  }
  await audit(store, actor, "photo_add", "photos", created.id, record.name ?? null);
  return shapePhoto(created);
}

export async function updatePhoto(id, payload = {}, actor) {
  const store = await getStore();
  await store.byId("photos", id);
  const { id: _ignored, album_id: _ignoredAlbum, ...fields } = payload;
  const clean = validate("photo", fields, { partial: true });
  const updated = await store.update("photos", id, clean);
  await audit(store, actor, "photo_update", "photos", id, null);
  return shapePhoto(updated);
}

export async function movePhoto(id, direction, actor) {
  const store = await getStore();
  const photo = await store.byId("photos", id);
  const siblings = await store.rawList("photos", {
    where: [{ col: "album_id", op: "eq", value: photo.album_id }, { col: "deleted_at", op: "is", value: null }],
    order: [{ col: "sort_order", dir: "asc" }, { col: "created_at", dir: "asc" }],
    select: PUBLIC_SELECT.photos,
  });
  const index = siblings.findIndex((row) => row.id === id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= siblings.length) return { ok: true, moved: false };
  const ordered = [...siblings];
  [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
  for (const [position, row] of ordered.entries()) {
    if (row.id === id || position === index || position === target) {
      await store.update("photos", row.id, { sort_order: position }).catch(() => null);
    }
  }
  await audit(store, actor, "photo_move", "photos", id, direction);
  return { ok: true, moved: true };
}

export async function trashPhoto(id, actor) {
  const store = await getStore();
  const photo = await store.byId("photos", id);
  await store.softDelete("photos", id);
  await audit(store, actor, "photo_trash", "photos", id, null);
  return { ok: true, album_id: photo.album_id };
}

export async function purgePhoto(id, actor, { confirm } = {}) {
  if (confirm !== "DELETE") throw badRequest("ছবিটি স্থায়ীভাবে মুছতে নিশ্চিতকরণ প্রয়োজন।");
  const store = await getStore();
  const photo = await store.byId("photos", id, { includeDeleted: true });
  await store.purge("photos", id);
  await releaseMedia(store, [photo.file_path]);
  await audit(store, actor, "photo_purge", "photos", id, null);
  return { ok: true, purged: true, album_id: photo.album_id };
}

/* ------------------------------------------------------------- public reads */

const PUBLIC_SELECT = {
  notices: ["id", "title", "body", "audience", "notice_type", "importance", "published_at", "file_path", "file_name", "file_mime", "file_bytes"],
  exam_routines: ["id", "exam_name", "class_name", "subject", "exam_date", "start_time", "room", "notes", "file_path", "file_name", "file_mime", "file_bytes", "sort_order"],
  routines: ["id", "title", "routine_type", "class_name", "event_date", "start_time", "end_time", "description", "file_path", "file_name", "file_mime", "file_bytes"],
  albums: ["id", "title", "description", "category", "album_date", "cover_photo_id"],
  photos: ["id", "album_id", "file_path", "alt_text", "caption", "pixel_width", "pixel_height", "sort_order"],
};

const NOT_DELETED = { col: "deleted_at", op: "is", value: null };
const publishedOnly = [{ col: "status", op: "eq", value: "published" }, NOT_DELETED];

const publicFile = (row) => (row.file_path ? fileMeta(row) : null);

/** The exact opposite of a sort rule, so a tail window reads back in the page's order. */
const reverseOrder = (order) =>
  order.map(({ col, dir, nullsFirst }) => ({ col, dir: dir === "asc" ? "desc" : "asc", nullsFirst: !nullsFirst }));

/**
 * One page of published rows, and everything a visitor needs to ask for the next one.
 *
 * A public list is a page, not the whole table, so the read layer has to say honestly
 * whether more rows exist. It does that by asking for one row more than it shows: the
 * extra row is the answer, and no counting query (capped at 1000 by both drivers) is
 * trusted with it. `offset` counts rows already shown, clamped to whole numbers, and a
 * tail-anchored feed walks backwards in time while still returning rows in its own
 * display order — which is what keeps the newest exam routine on screen even when the
 * school has published hundreds of them.
 */
const publicPage = async (name, { limit, offset } = {}) => {
  const spec = RESOURCES[name];
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || spec.publicPage, 1), spec.publicMax);
  const from = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const store = await getStore();
  const rows = await store.rawList(spec.table, {
    where: publishedOnly,
    order: spec.publicTail ? reverseOrder(spec.publicOrder) : spec.publicOrder,
    limit: size + 1,
    offset: from,
    select: PUBLIC_SELECT[spec.table],
  });
  const hasMore = rows.length > size;
  const page = rows.slice(0, size);
  return {
    rows: spec.publicTail ? page.reverse() : page,
    info: { limit: size, offset: from, has_more: hasMore, next_offset: hasMore ? from + size : null },
  };
};

export async function publicNotices(query = {}) {
  const { rows, info } = await publicPage("notices", query);
  return {
    notices: rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      audience: row.audience || null,
      type: row.notice_type,
      importance: row.importance,
      date: row.published_at,
      date_label: toBengaliDate(row.published_at),
      file: publicFile(row),
    })),
    ...info,
  };
}

/** Read newest window first, returned in the page's own ascending order. */
export async function publicExams(query = {}) {
  const { rows, info } = await publicPage("exams", query);
  return {
    exams: rows.map((row) => ({
      id: row.id,
      exam_name: row.exam_name,
      class_name: row.class_name,
      subject: row.subject,
      date: row.exam_date,
      date_label: toBengaliDate(row.exam_date),
      time: row.start_time ? String(row.start_time).slice(0, 5) : null,
      room: row.room || null,
      notes: row.notes || null,
      file: publicFile(row),
    })),
    ...info,
  };
}

export async function publicRoutines(query = {}) {
  const { rows, info } = await publicPage("routines", query);
  return {
    routines: rows.map((row) => ({
      id: row.id,
      title: row.title,
      routine_type: row.routine_type,
      class_name: row.class_name || null,
      date: row.event_date,
      date_label: toBengaliDate(row.event_date),
      start_time: row.start_time ? String(row.start_time).slice(0, 5) : null,
      end_time: row.end_time ? String(row.end_time).slice(0, 5) : null,
      description: row.description || null,
      file: publicFile(row),
    })),
    ...info,
  };
}

export async function publicGallery({ albums = 40, perAlbum = 8 } = {}) {
  const store = await getStore();
  const rows = await store.rawList("albums", {
    where: publishedOnly,
    order: RESOURCES.albums.publicOrder,
    limit: Math.min(Math.max(Number(albums) || 40, 1), 100),
    select: PUBLIC_SELECT.albums,
  });
  if (!rows.length) return [];
  const list = await store.rawList("photos", {
    where: [{ col: "album_id", op: "in", value: rows.map((row) => row.id) }, NOT_DELETED],
    order: [{ col: "sort_order", dir: "asc" }, { col: "created_at", dir: "asc" }],
    select: PUBLIC_SELECT.photos,
  });
  const grouped = new Map();
  for (const photo of list) {
    const bucket = grouped.get(photo.album_id) ?? [];
    if (bucket.length < perAlbum) bucket.push(photo);
    grouped.set(photo.album_id, bucket);
  }
  return rows.map((album) => {
    const items = grouped.get(album.id) ?? [];
    return {
      id: album.id,
      title: album.title,
      description: album.description || null,
      category: album.category || null,
      date: album.album_date,
      date_label: toBengaliDate(album.album_date),
      photo_count: items.length,
      photos: items.map((photo) => ({
        id: photo.id,
        alt: photo.alt_text || album.title,
        caption: photo.caption || null,
        width: photo.pixel_width || 1200,
        height: photo.pixel_height || 900,
        thumb: mediaUrl(photo.file_path, thumbTransform()),
        full: mediaUrl(photo.file_path),
      })),
    };
  });
}

export async function publicAlbum(id) {
  const store = await getStore();
  const album = await store.one("albums", [{ col: "id", op: "eq", value: id }, ...publishedOnly]);
  if (!album) throw notFound();
  const photos = await store.rawList("photos", {
    where: [{ col: "album_id", op: "eq", value: id }, NOT_DELETED],
    order: [{ col: "sort_order", dir: "asc" }, { col: "created_at", dir: "asc" }],
    select: PUBLIC_SELECT.photos,
  });
  return {
    id: album.id,
    title: album.title,
    description: album.description || null,
    category: album.category || null,
    date: album.album_date,
    date_label: toBengaliDate(album.album_date),
    photos: photos.map((photo) => ({
      id: photo.id,
      alt: photo.alt_text || album.title,
      caption: photo.caption || null,
      width: photo.pixel_width || 1200,
      height: photo.pixel_height || 900,
      thumb: mediaUrl(photo.file_path, thumbTransform()),
      full: mediaUrl(photo.file_path),
    })),
  };
}

/* ------------------------------------------------------------------ dashboard */

export async function dashboardCounts(actor) {
  const store = actor.store;
  const published = await Promise.all(Object.values(RESOURCES).map((spec) => store.count(spec.table, publishedOnly)));
  const drafts = await Promise.all(
    Object.values(RESOURCES).map((spec) => store.count(spec.table, [{ col: "status", op: "eq", value: "draft" }, NOT_DELETED])),
  );
  const trashCount = await Promise.all(
    Object.values(RESOURCES).map((spec) => store.count(spec.table, [{ col: "deleted_at", op: "is_not", value: null }])),
  );
  const recent = await store.audit.recent(12);
  const keys = Object.keys(RESOURCES);
  const totals = {};
  keys.forEach((key, index) => {
    totals[key] = { published: published[index], draft: drafts[index], trashed: trashCount[index], label: RESOURCES[key].label };
  });
  return {
    totals,
    recent: recent.map((row) => ({
      action: row.action,
      entity: row.entity,
      email: row.user_email,
      detail: row.detail,
      at: row.created_at,
    })),
    storage: { driver: config.driver, bucket: config.driver === "supabase" ? config.storageBucket : "local" },
  };
}

export { ENTITIES };

export { moduleOnly as default } from "./guard.mjs";
