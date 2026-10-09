#!/usr/bin/env node
/* The direct-to-storage half of the gallery upload fix, checked with no network.
 *
 * A photo too big for a function request is PUT straight into the storage bucket with
 * a grant this server mints, so the two things worth proving are (1) the grant the
 * browser receives is shaped the way Supabase expects and carries no secret, and
 * (2) the staging area cannot be used to name — or to clean up — anything the school
 * has already published. Both are checked here against a recorded fake fetch, so a
 * mistake surfaces in a test run rather than on a live deployment.
 *
 *   cd tools && node test-storage-direct.mjs
 */

import path from "node:path";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const { createDriver } = await import(path.join(ROOT, "api/_lib/drivers/supabase.mjs"));
const { config, publicStorageKey } = await import(path.join(ROOT, "api/_lib/config.mjs"));
const { stagingKey, isStagingKey, directUploadReady, beginStagedUpload, sweepStagedUploads, STAGING_PREFIX } = await import(
  path.join(ROOT, "api/_lib/media.mjs")
);

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

const JWT = (claims) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;
const SERVICE_KEY = JWT({ role: "service_role", iss: "supabase" });
const ANON_KEY = JWT({ role: "anon", iss: "supabase" });
const BUCKET = "media";
const BASE = "https://project.supabase.co";
const STAGING = `${STAGING_PREFIX}/2026-10/11111111-1111-4111-8111-111111111111`;

/** createDriver is async (it may warm a connection); build the driver once. */
const driver = await createDriver({ supabaseUrl: BASE, supabaseServiceRoleKey: SERVICE_KEY, storageBucket: BUCKET });

const response = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (payload === undefined ? "" : JSON.stringify(payload)),
  json: async () => payload,
});

/** Runs `run` with fetch recorded, and hands back every request that was made. */
const recorded = async (handler, run) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body });
    return response(...((await handler(String(url), init)) ?? [201, {}]));
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
};

console.log("\n— the upload grant the browser is given —");
await check("sign() asks the storage API for a grant for exactly one staging path", async () => {
  await recorded(
    () => [201, { url: `/object/upload/sign/media/${STAGING}?token=abc123`, token: "abc123" }],
    async (calls) => {
      const grant = await driver.media.sign(STAGING, { contentType: "image/png" });
      assert(calls.length === 1, `${calls.length} requests were made`);
      assert(calls[0].method === "POST", `sign used ${calls[0].method}`);
      assert(
        calls[0].url === `${BASE}/storage/v1/object/upload/sign/${BUCKET}/${STAGING}`,
        `unexpected sign url ${calls[0].url}`,
      );
      assert(calls[0].body === "{}", `the sign body was ${JSON.stringify(calls[0].body)}`);
      assert(grant.method === "PUT", `the browser was told to ${grant.method}`);
      assert(grant.upload_url === `${BASE}/storage/v1/object/upload/sign/${BUCKET}/${STAGING}?token=abc123`, grant.upload_url);
      assert(grant.headers["content-type"] === "image/png", "the declared type was dropped");
      assert(grant.headers["x-upsert"] === "false", "an upload could overwrite an existing object");
    },
  );
});
await check("both response shapes Supabase has used are normalised, token included", async () => {
  for (const payload of [
    { url: `/object/upload/sign/media/${STAGING}?token=tok1` }, // relative, token only in the query
    { signedURL: `${BASE}/storage/v1/object/upload/sign/${BUCKET}/${STAGING}?token=tok2` }, // absolute, older field name
    { signedUrl: `${BASE}/storage/v1/object/upload/sign/${BUCKET}/${STAGING}?token=tok3`, token: "tok3" },
  ]) {
    const grant = await recorded(() => [201, payload], async () => driver.media.sign(STAGING, { contentType: "image/jpeg" }));
    assert(/^https:\/\/project\.supabase\.co\/storage\/v1\/object\/upload\/sign\/media\/images\/incoming\//.test(grant.upload_url), JSON.stringify(grant));
    assert(/\?token=tok/.test(grant.upload_url), `the token is missing from ${grant.upload_url}`);
  }
});
await check("nothing the server keeps secret can ride along in the grant", async () => {
  config.storagePublicKey = "";
  const grant = await recorded(() => [201, { url: `/object/upload/sign/media/${STAGING}?token=abc`, token: "abc" }], async () =>
    driver.media.sign(STAGING, { contentType: "image/png" }),
  );
  const wire = JSON.stringify(grant);
  assert(!wire.includes(SERVICE_KEY), "the service-role key leaked into the grant");
  assert(!wire.includes("service_role"), `a credential shape leaked: ${wire}`);
  assert(!("apikey" in grant.headers) && !("Authorization" in grant.headers), "an authorisation header was sent without being configured");
});
await check("only a recognisably public key may be published, and only if configured", async () => {
  const cases = [
    ["", "", "nothing configured sends nothing"],
    [ANON_KEY, ANON_KEY, "an anon JWT is public by definition"],
    ["sb_publishable_abcdefghijklmnop", "sb_publishable_abcdefghijklmnop", "the publishable key is public by definition"],
    [SERVICE_KEY, "", "a service_role JWT must never reach a browser"],
    ["sb_secret_abcdefghijklmnop", "", "a secret key must never reach a browser"],
    ["completely-unknown-shape", "", "an unrecognised shape is not published on a guess"],
  ];
  for (const [configured, expected, why] of cases) {
    config.storagePublicKey = configured;
    assert(publicStorageKey() === expected, `${why} — got ${JSON.stringify(publicStorageKey())}`);
    const grant = await recorded(() => [201, { url: `/object/upload/sign/media/${STAGING}?token=abc`, token: "abc" }], async () =>
      driver.media.sign(STAGING, { contentType: "image/png" }),
    );
    if (expected) {
      assert(grant.headers.apikey === expected && grant.headers.Authorization === `Bearer ${expected}`, `the header pair was not applied: ${why}`);
    } else {
      assert(!grant.headers.apikey && !grant.headers.Authorization, `a header was applied anyway: ${why}`);
    }
  }
  config.storagePublicKey = "";
});
await check("a storage that cannot sign is reported, not swallowed", async () => {
  const failure = await recorded(() => [500, { error: "invalid json body" }], async () => {
    try {
      await driver.media.sign(STAGING, { contentType: "image/png" });
      return null;
    } catch (error) {
      return { status: error.status, code: error.code, message: error.message };
    }
  });
  assert(failure?.status === 502 && failure.code === "sign_failed", JSON.stringify(failure));
  assert(!String(failure.message).includes(SERVICE_KEY), "the error text quoted a credential");
  const unreachable = await recorded(
    async () => {
      throw Object.assign(new Error("boom"), { cause: { code: "ENOTFOUND" } });
    },
    async () => {
      try {
        await driver.media.sign(STAGING, { contentType: "image/png" });
        return null;
      } catch (error) {
        return { status: error.status, code: error.code };
      }
    },
  );
  assert(unreachable?.status === 503 && unreachable.code === "storage_unreachable", JSON.stringify(unreachable));
});

console.log("\n— what the verification step is allowed to look at —");
await check("stat() reports the recorded size so an oversized file is refused before it is read", async () => {
  const info = await recorded(() => [200, { name: "11111111", metadata: { size: 5_760_000, mimetype: "image/png" } }], async () =>
    driver.media.stat(STAGING),
  );
  assert(info.bytes === 5_760_000 && info.mime === "image/png", JSON.stringify(info));
  const gone = await recorded(() => [404, { error: "not found" }], async () => driver.media.stat(STAGING));
  assert(gone === null, `a missing object reported ${JSON.stringify(gone)}`);
});
await check("list() answers with whatever the bucket has, and nothing when it cannot", async () => {
  const rows = [{ name: "aaaaaaaa-0000-4000-8000-000000000000", updated_at: "2026-10-01T00:00:00Z" }];
  const listed = await recorded(() => [200, rows], async (calls) => {
    const found = await driver.media.list(`${STAGING_PREFIX}/2026-10/`, 50);
    return { found, url: calls[0].url, body: JSON.parse(calls[0].body) };
  });
  assert(listed.url === `${BASE}/storage/v1/object/list/${BUCKET}`, listed.url);
  assert(listed.body.prefix === `${STAGING_PREFIX}/2026-10/`, `prefix was ${listed.body.prefix}`);
  assert(listed.found.length === 1, JSON.stringify(listed.found));
  const empty = await recorded(() => [500, {}], async () => driver.media.list("images/incoming/", 10));
  assert(Array.isArray(empty) && empty.length === 0, "a failing listing must not throw at the caller");
});
await check("a staging key is its own shape and can never look like a stored photo", async () => {
  const key = stagingKey();
  assert(isStagingKey(key), key);
  assert(key !== stagingKey(), "two grants named the same path");
  // The media route serves images/<month>/<uuid>.<ext>; a staging key must not match it,
  // which is why an uncommitted object has no URL rather than merely a private one.
  assert(!/^images\/\d{4}-\d{2}\/[0-9a-f-]{36}\.(jpg|png|webp|gif|pdf)$/.test(key), "a staging key is routable by /api/media");
  for (const notStaging of [
    "images/2026-10/11111111-1111-4111-8111-111111111111.png", // a published photo
    "docs/2026-10/11111111-1111-4111-8111-111111111111.pdf", // a notice attachment
    `${STAGING}.png`, // staging with an extension
    `${STAGING}/extra`, // one segment too many
    `${STAGING_PREFIX}/2026/11111111-1111-4111-8111-111111111111`, // not a month folder
    `${STAGING_PREFIX}/2026-10/11111111-1111-4111-f111-111111111111`, // not a v4 UUID
    `${STAGING_PREFIX}/2026-10/../../2026-10/x`,
    "",
    null,
    undefined,
  ]) {
    assert(!isStagingKey(notStaging), `isStagingKey accepted ${JSON.stringify(notStaging)}`);
  }
});
await check("the sweep clears stale staging in this month and last, and nothing else", async () => {
  const month = new Date().toISOString().slice(0, 7);
  const previous = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString().slice(0, 7);
  const old = Date.now() - 9 * 60 * 60 * 1000;
  const removed = [];
  const listing = {
    [`${STAGING_PREFIX}/${month}/`]: [
      { path: `${STAGING_PREFIX}/${month}/aaaaaaaa-0000-4000-8000-000000000000`, mtimeMs: old }, // stale, full key
      { name: "bbbbbbbb-0000-4000-8000-000000000000", updated_at: new Date(old).toISOString() }, // stale, bare name
      { name: "cccccccc-0000-4000-8000-000000000000", updated_at: new Date().toISOString() }, // still inside its window
      { name: "dddddddd-dddd-4ddd-cddd-dddddddddddd", mtimeMs: old }, // not a v4 UUID: the variant nibble is wrong
      { name: month, id: null }, // the folder itself, not an object
      { path: `images/${month}/eeeeeeee-0000-4000-8000-000000000000.png`, mtimeMs: old }, // a published photo
      { path: `docs/${month}/ffffffff-0000-4000-8000-000000000000.pdf`, mtimeMs: old }, // a notice attachment
    ],
    [`${STAGING_PREFIX}/${previous}/`]: [{ name: "99999999-0000-4000-8000-000000000000", created_at: new Date(old).toISOString() }],
  };
  const store = {
    driver: {
      media: {
        list: async (prefix) => listing[prefix] ?? [],
        remove: async (key) => removed.push(key),
      },
    },
  };
  const count = await sweepStagedUploads(store, { olderThanMs: 6 * 60 * 60 * 1000 });
  assert(count === 3, `${count} object(s) were scheduled for removal`);
  assert(
    removed.join(",") ===
      [
        `${STAGING_PREFIX}/${month}/aaaaaaaa-0000-4000-8000-000000000000`,
        `${STAGING_PREFIX}/${month}/bbbbbbbb-0000-4000-8000-000000000000`,
        `${STAGING_PREFIX}/${previous}/99999999-0000-4000-8000-000000000000`,
      ].join(","),
    `the sweep removed ${JSON.stringify(removed)}`,
  );
  assert(removed.every((key) => isStagingKey(key)), "a key outside the staging shape was handed to remove()");
});
await check("a listing that throws cannot take anything with it", async () => {
  const removed = [];
  const store = { driver: { media: { list: async () => { throw new Error("bucket unavailable"); }, remove: async (key) => removed.push(key) } } };
  assert((await sweepStagedUploads(store, { olderThanMs: 0 })) === 0, "a failing listing should remove nothing");
  assert(removed.length === 0, JSON.stringify(removed));
  assert(directUploadReady({ driver: { media: { list: async () => [] } } }) === false, "listing alone is not a grant capability");
});

console.log("\n— how the admin is told what this deployment can do —");
await check("the capability the admin plans around follows the driver and the switch", async () => {
  config.directUploads = true;
  assert(directUploadReady({ driver: { media: { sign: async () => ({}) } } }) === true, "a driver that can sign should offer grants");
  assert(directUploadReady({ driver: { media: {} } }) === false, "a driver without sign must not offer grants");
  assert(directUploadReady(null) === false, "a missing store must not offer grants");
  config.directUploads = false;
  assert(directUploadReady({ driver: { media: { sign: async () => ({}) } } }) === false, "CMS_DIRECT_UPLOADS=0 must switch the whole path off");
  config.directUploads = true;
});
await check("a file over the app's own limit is refused at once, with the limit named", async () => {
  config.maxImageBytes = 8 * 1024 * 1024;
  let thrown = null;
  try {
    await beginStagedUpload({ name: "enormous.png", size: 12 * 1024 * 1024 });
  } catch (error) {
    thrown = error;
  }
  assert(thrown?.status === 413, `expected a 413, got ${thrown?.status}`);
  assert(/12\.0 MB/.test(thrown.message) && /8 MB/.test(thrown.message), thrown.message);
});
await check("when the switch is off the caller is told, so the form path can be used", async () => {
  config.directUploads = false;
  const result = await beginStagedUpload({ name: "small.png", size: 200_000 });
  assert(result.supported === false && typeof result.reason === "string" && result.reason.length > 4, JSON.stringify(result));
  config.directUploads = true;
});

const failed = results.filter((row) => !row.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("\nfailures:\n" + failed.map((row) => `  ✗ ${row.name} — ${row.detail}`).join("\n"));
  process.exitCode = 1;
}
