/* Authentication and authorization for the admin API.
 *
 * How it works, end to end:
 *   1. POST /api/cms/login  → password checked against a scrypt hash in Postgres.
 *   2. On success the server mints a random 256-bit session token, stores only its
 *      SHA-256 hash (with an expiry) and returns it as an HttpOnly cookie.
 *   3. Every later request re-reads that cookie, looks the session up, confirms the
 *      user is still active, then slides the expiry. Logout deletes the row, so a
 *      cookie cannot outlive logout and a stolen dump cannot be replayed.
 *   4. State-changing requests additionally need the double-submit CSRF value.
 *
 * There is no client-side "logged in" flag anywhere: the admin screens are static
 * files, but every read of drafts and every write is refused without the cookie.
 */

import crypto from "node:crypto";

import { config, assertProductionConfig } from "./config.mjs";
import { HttpError, assertSameOrigin, badRequest, forbidden, unauthorized, parseCookies, sessionCookie, csrfCookie, tooMany } from "./http.mjs";
import { getStore } from "./db.mjs";

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024, keylen: 64 };

/* ------------------------------------------------------------ passwords */

export const hashPassword = (password) => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
};

export const verifyPassword = (password, stored) => {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored).split("$");
    if (scheme !== "scrypt") return false;
    const expected = Buffer.from(hash, "base64url");
    const actual = crypto.scryptSync(String(password), Buffer.from(salt, "base64url"), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};

/* -------------------------------------------------------------- tokens */

const tokenHash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const csrfFor = (hash) => crypto.createHash("sha256").update(`${hash}:csrf`).digest("hex").slice(0, 32);

const SESSION_MAX_AGE = () => config.sessionHours * 3600;

/* --------------------------------------------------------------- login */

// Single-instance throttle; the durable lock-out lives on the user row so it
// survives cold starts and applies no matter which container sees the request.
const attempts = new Map();
const WINDOW = () => config.loginWindowMinutes * 60_000;

const throttleKey = (req, email) => `${config.driver}:${String(email).toLowerCase().trim()}`;

const tooManyAttempts = (key) => {
  const now = Date.now();
  const record = attempts.get(key) ?? { count: 0, resetAt: now + WINDOW() };
  if (record.resetAt < now) {
    record.count = 0;
    record.resetAt = now + WINDOW();
  }
  record.count += 1;
  attempts.set(key, record);
  if (attempts.size > 5000) attempts.clear();
  if (record.count > config.loginMaxFails) {
    const seconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
    throw tooMany(`অনেকবার চেষ্টা হয়েছে। ${seconds} সেকেন্ড পরে আবার চেষ্টা করুন।`);
  }
};

const clearThrottle = (key) => attempts.delete(key);

const genericFailure = () => new HttpError(401, "invalid_credentials", "ইমেইল বা পাসওয়ার্ড সঠিক নয়।");

/** Creates the session row and the two cookies. Returns headers for the response. */
export async function startSession(store, user, req) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = tokenHash(token);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE() * 1000).toISOString();
  await store.sessions.create({
    user_id: user.id,
    token_hash: hash,
    ip: req?.socket?.remoteAddress ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || null : null,
    user_agent: String(req.headers["user-agent"] || "").slice(0, 300),
    expires_at: expiresAt,
  });
  return {
    csrfToken: csrfFor(hash),
    headers: { "Set-Cookie": [sessionCookie(token, req, SESSION_MAX_AGE()), csrfCookie(csrfFor(hash), req)] },
  };
}

export async function endSession(store, token) {
  if (token) await store.sessions.drop(tokenHash(token));
}

/** Current user for this request, or null. Never throws. */
export async function currentUser(req, providedStore) {
  const store = providedStore ?? (await getStore());
  const token = parseCookies(req)[config.cookieName];
  if (!token || token.length < 20) return null;
  const session = await store.sessions.byToken(tokenHash(token)).catch(() => null);
  if (!session) return null;
  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
    await store.sessions.drop(tokenHash(token)).catch(() => {});
    return null;
  }
  const user = await store.users.byId(session.user_id).catch(() => null);
  if (!user || user.is_active === false) return null;
  // Sliding expiry, so an active teacher is never logged out mid-job.
  await store.driver
    .privileged("update", { table: "cms_sessions", id: session.id, patch: { expires_at: new Date(Date.now() + SESSION_MAX_AGE() * 1000).toISOString() } })
    .catch(() => null);
  return { user, csrf: csrfFor(session.token_hash) };
}

/**
 * Auth guard for every admin route.
 * 401 when there is no valid session; 403 for a valid session with a bad
 * origin or a missing CSRF token (so an attacker cannot tell which accounts exist).
 */
export async function requireUser(req, { csrf = true } = {}) {
  const store = await getStore();
  const found = await currentUser(req, store);
  if (!found) throw unauthorized();
  if (csrf) {
    assertSameOrigin(req, parseCookies(req));
    const expected = found.csrf;
    if (!expected || String(req.headers[config.csrfHeaderName] || "") !== expected) {
      throw forbidden("সেশনের টোকেন মেলেনি — পেজটি রিলোড করে আবার চেষ্টা করুন।");
    }
  }
  return { ...found, store };
}

export const requireAdminRole = (actor) => {
  if (actor.user.role !== "admin") throw forbidden("শুধুমাত্র অ্যাডমিন অ্যাকাউন্ট পরিবর্তন করতে পারেন।");
  return actor;
};

/* --------------------------------------------------------------- login */

export async function login(req, body) {
  const store = await getStore();
  const problems = assertProductionConfig();
  if (problems.length) throw badRequest(`সার্ভার সেটআপ অসম্পূর্ণ: ${problems.join(" ")}`);

  const email = String(body.email ?? "").toLowerCase().trim().slice(0, 160);
  const password = String(body.password ?? "");
  if (!email || !password) throw badRequest("ইমেইল ও পাসওয়ার্ড দুটিই দিতে হবে।");

  const key = throttleKey(req, email);
  tooManyAttempts(key);

  const user = await store.users.byEmail(email);
  // Same work either way, so response time does not reveal which accounts exist.
  const placeholder = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const okPassword = verifyPassword(password, user?.password_hash || placeholder);
  if (!user || !okPassword) {
    if (user) await noteFailure(store, user);
    throw genericFailure();
  }
  if (user.is_active === false) throw forbidden("এই অ্যাকাউন্টটি নিষ্ক্রিয় করা হয়েছে।");
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    throw tooMany(`অ্যাকাউন্ট সাময়িকভাবে বন্ধ আছে। ${new Date(user.locked_until).toLocaleTimeString("bn-BD", { hour: "2-digit", minute: "2-digit" })}-এর পরে চেষ্টা করুন।`);
  }

  clearThrottle(key);
  await store.driver
    .privileged("update", { table: "cms_users", id: user.id, patch: { failed_attempts: 0, locked_until: null, last_login_at: new Date().toISOString() } })
    .catch(() => null);
  await store.audit.add({ user_id: user.id, user_email: user.email, action: "login", entity: "session", entity_id: null, detail: null });
  const session = await startSession(store, user, req);
  return { status: 200, body: { ok: true, user: publicUser(user), csrfToken: session.csrfToken }, headers: session.headers };
}

async function noteFailure(store, user) {
  const failures = Number(user.failed_attempts ?? 0) + 1;
  const patch = { failed_attempts: failures };
  if (failures >= config.loginMaxFails) patch.locked_until = new Date(Date.now() + WINDOW()).toISOString();
  await store.driver.privileged("update", { table: "cms_users", id: user.id, patch }).catch(() => null);
}

export const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  fullName: user.full_name,
  role: user.role,
  isAdmin: user.role === "admin",
});

/** First-run account creation, guarded by CMS_ALLOW_SETUP=1 and an empty table. */
export async function bootstrap(req, body) {
  const store = await getStore();
  if (String(process.env.CMS_ALLOW_SETUP || "").toLowerCase() !== "1") {
    throw forbidden("প্রথম অ্যাকাউন্ট তৈরি করতে পরিবেশে CMS_ALLOW_SETUP=1 দিন (সেটআপ শেষ হলে সরিয়ে ফেলুন)।");
  }
  const existing = await store.users.count();
  if (existing > 0) throw forbidden("অ্যাকাউন্ট ইতিমধ্যেই তৈরি হয়েছে। CMS_ALLOW_SETUP সরিয়ে ফেলুন।");

  const email = String(body.email ?? "").toLowerCase().trim();
  const fullName = String(body.full_name ?? "").trim();
  const password = String(body.password ?? "");
  const errors = {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = "সঠিক ইমেইল দিন।";
  if (fullName.length < 2 || fullName.length > 80) errors.full_name = "নাম ২–৮০ অক্ষরের হতে হবে।";
  if (password.length < 10) errors.password = "পাসওয়ার্ড অন্তত ১০ অক্ষরের হতে হবে।";
  if (Object.keys(errors).length) throw badRequest("সেটআপ ফরমটি পূরণ করুন।", errors);

  const created = await store.driver.privileged("insert", {
    table: "cms_users",
    row: { email, full_name: fullName, role: "admin", password_hash: hashPassword(password), is_active: true },
  });
  await store.audit.add({ user_id: created?.id, user_email: email, action: "setup", entity: "cms_users", entity_id: created?.id, detail: "প্রথম অ্যাডমিন অ্যাকাউন্ট তৈরি" });
  const session = await startSession(store, created, req);
  return { status: 201, body: { ok: true, user: publicUser(created), csrfToken: session.csrfToken }, headers: session.headers };
}

export async function changePassword(req, actor, body) {
  const current = String(body.current_password ?? "");
  const next = String(body.new_password ?? "");
  if (next.length < 10) throw badRequest("নতুন পাসওয়ার্ড অন্তত ১০ অক্ষরের হতে হবে।", { new_password: "অন্তত ১০ অক্ষর।" });
  const withHash = await actor.store.driver.privileged("one", {
    table: "cms_users",
    columns: "all",
    where: [{ col: "id", op: "eq", value: actor.user.id }],
  });
  if (!verifyPassword(current, withHash?.password_hash)) throw badRequest("বর্তমান পাসওয়ার্ডটি সঠিক নয়।", { current_password: "ভুল পাসওয়ার্ড।" });
  await actor.store.driver.privileged("update", { table: "cms_users", id: actor.user.id, patch: { password_hash: hashPassword(next) } });
  await actor.store.sessions.dropForUser(actor.user.id);
  await actor.store.audit.add({ user_id: actor.user.id, user_email: actor.user.email, action: "password_change", entity: "cms_users", entity_id: actor.user.id, detail: null });
  return { ok: true, reauthRequired: true };
}

/* ---------------------------------------------------------------- misc */

export const newId = () => crypto.randomUUID();

export { tokenHash, csrfFor };

export { moduleOnly as default } from "./guard.mjs";
