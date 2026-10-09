# CMS — একবারের সেটআপ (one-time setup guide)

This file is for whoever deploys the site (a developer or the school's IT person).
**The Computer Teacher never needs any of this** — once the steps below are done,
the dashboard at `/admin/` is the whole system.

The design in one line:

```
Teacher → /admin/ (cookie login) → Vercel Serverless Function (/api) → Supabase (Postgres + Storage) → same public pages
```

Nothing was replaced on the public site: its approved markup, CSS and images are unchanged.
The pages now *add* rows from the database when published content exists, and keep showing
their existing static content when it does not.

---

## 1. Create the database (Supabase free tier is enough)

1. <https://supabase.com> → **New project** — any name (e.g. `rajapur-cms`), region
   closest to your users, and **save the database password**.
2. Open **SQL Editor** → New query → paste the entire contents of
   [`supabase/schema.sql`](../supabase/schema.sql) → **Run**.
   It creates 8 tables (`cms_users`, `cms_sessions`, `cms_audit`, `notices`,
   `exam_routines`, `routines`, `albums`, `photos`), turns on row-level security with
   **no public policies**, and creates the private `media` storage bucket.
   It is idempotent — safe to run again.
3. **Settings → API**: copy the **Project URL** and the **`service_role` secret key**.

> The `service_role` key is the master key of the database. It goes **only** into Vercel
> environment variables (server side). It is never written into any file in this repo and
> never reaches the browser — the admin app and the public pages only ever call `/api/...`
> on the same site.

## 2. Give the two values to Vercel

Vercel → your project → **Settings → Environment Variables** → add both for
**Production**, **Preview** and **Development**:

| Name | Value | Type |
| --- | --- | --- |
| `SUPABASE_URL` | the Project URL, e.g. `https://abcd1234.supabase.co` | Plain |
| `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` secret key | **Sensitive** |

Then **Deployments → … → Redeploy** so the functions pick them up.

Both key formats are accepted, because Supabase publishes two: the legacy JWT whose
payload says `role: "service_role"`, and the current `sb_secret_…` key. What the API
refuses is a *public* credential used as a server one — an `anon` JWT or an
`sb_publishable_…` key — and anything that cannot be read at all (a truncated paste),
which it reports by length rather than by echoing your key. Quotes, spaces, a stray
`Bearer ` prefix or a copied `/rest/v1` suffix are cleaned up before checking, so a
correct key pasted imperfectly still works.

Check it worked: open `https://<your-domain>/api/public/health`.
You should get JSON with `"configProblems": []`. If the list is not empty, it names
exactly what is missing.

## 3. Create the first admin account (one deploy only)

1. Add one more environment variable temporarily: `CMS_ALLOW_SETUP` = `1`, redeploy.
2. Open `https://<your-domain>/admin/`. The screen shows the first-run form
   (name, email, password — password at least 10 characters). Submitting creates the
   account, logs you in, and you land on the dashboard.
3. **Delete `CMS_ALLOW_SETUP`** and redeploy. The setup form is then closed forever:
   the API refuses `/api/cms/setup` both because the flag is gone and because accounts
   already exist. New staff accounts are added inside the dashboard on the
   **অ্যাকাউন্ট** screen (only an `admin` role sees it).

The account screen (**আমার অ্যাকাউন্ট**) lets the teacher change their own password;
doing so signs every other device out.

## 4. Optional knobs

All have sensible defaults and none are needed for a first launch:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CMS_DRIVER` | `supabase` | `local` = dev-only JSON/file store (below) |
| `CMS_STORAGE_BUCKET` | `media` | Supabase bucket for uploads |
| `CMS_IMAGE_TRANSFORM` | `1` | Ask Supabase for resized WebP thumbnails |
| `CMS_THUMB_WIDTH` / `_HEIGHT` / `_QUALITY` | `800` / `600` / `72` | Thumbnail render size |
| `CMS_MAX_IMAGE_BYTES` | `8388608` (8 MB) | Rejected before a byte is stored |
| `CMS_MAX_DOCUMENT_BYTES` | `5242880` (5 MB) | PDF/doc limit |
| `CMS_MAX_IMAGES_PER_UPLOAD` | `6` | Photos per form request (all validated and stored inside that one call) |
| `CMS_DIRECT_UPLOADS` | `1` | Large photos are PUT straight to storage; `0` forces every upload through the API |
| `CMS_STORAGE_PUBLIC_KEY` | empty | Only if the project's gateway demands a key on a storage PUT — publishable/anon key, never a secret |
| `CMS_STAGING_MAX_AGE_HOURS` | `6` | How long an abandoned, never-registered upload is kept before a sweep clears it |
| `CMS_SESSION_HOURS` | `12` | Sliding session lifetime |
| `CMS_LOGIN_MAX_FAILS` / `CMS_LOGIN_WINDOW_MINUTES` | `8` / `15` | Per-IP+email lockout |
| `CMS_PUBLIC_CACHE_SECONDS` | `60` | CDN cache for `/api/public/*` |

### Why a large photo does not travel through the API

Vercel refuses any function request body over **4.5 MB** — `413 FUNCTION_PAYLOAD_TOO_LARGE`,
returned by the platform before `api/cms/[...path].mjs` runs, and not adjustable in code or
`vercel.json`. That sits *below* this app's own 8 MB per-photo limit, which is why an edited
5.76 MB picture failed with a bare HTTP 413 while an ordinary phone photo worked: nothing in
the school's code was involved, and no error message of ours could have been shown.

The admin therefore splits a selection. Photos that fit travel together, in batches of at most
3.5 MB per request, so the multipart framing stays under the ceiling. A photo too big for one
request is instead PUT to a staging key this API minted (`images/incoming/<month>/<uuid>`, via
a single-use signed upload URL), and only then read back, validated from its own bytes and
registered. Nothing is in the album until that last step, and the staging object is deleted
whichever way the check goes — a half-finished upload is left behind neither in the database
nor in the bucket. A staging key is also outside the pattern `/api/media` serves, so such an
object is not merely private, it has no URL at all.

The bucket itself needs no change: no policy, setting or existing object is touched, and the
photo is registered under the same `images/<month>/…` key a form upload would have used.

### Testing an upload without touching the school's data

Preview and Production share one Supabase project, so anything typed on either one is the
school's real data. Two ways to test the flow anyway, in the order they should be tried:

1. **No account, no network — `npm run test:supabase`.** This drives the real
   `api/_lib/drivers/supabase.mjs` over real sockets against a throwaway loopback service
   that answers with Supabase Storage's HTTP contract: the same paths, verbs, response
   shapes and status codes. It proves everything on this side of the wire — a grant names
   exactly one key and one use, the browser's PUT needs no session, commit registers the
   bytes storage actually holds, every failure path empties staging, `/api/media` still
   enforces publication, a storage outage falls back instead of failing the upload.
2. **A throwaway Supabase project — the only way to test Supabase's side.** Whether the
   storage gateway accepts a token-only PUT for a bucket that has no policies, whether the
   bucket's `file_size_limit` is large enough, and CORS from a real browser cannot be
   proven by any fake. Steps, all of which leave the school's project untouched:

   1. Supabase → **New project**, e.g. `rahs-cms-test`, its own database password.
   2. Its SQL Editor → paste `supabase/schema.sql` → **Run**. Every statement is
      `if not exists` / `on conflict do nothing`, and it only creates the tables and the
      private `media` bucket. Run it on the **test** project.
   3. Add **no** storage policies and leave the bucket private — that is what the schema
      assumes and what `/api/media` relies on.
   4. Test project → Settings → API → copy its **Project URL** and **`service_role`** key.
   5. Vercel → project → Settings → Environment Variables → `SUPABASE_URL` and
      `SUPABASE_SERVICE_ROLE_KEY` with **Environment: Preview only** (Production keeps the
      school's values; a Preview-scoped variable overrides an `All`-scoped one of the same
      name). Add `CMS_ALLOW_SETUP=1` there too, for one deploy.
   6. Redeploy Preview, then open `https://<preview-host>/api/cms/status`: it must answer
      `driver: "supabase"` with `configProblems: []`. That is the confirmation Preview is
      talking to the test project and not to the school's.
   7. Sign in at `/admin/`, create a first account with a password that is **not** the
      real one, upload the photo that was too big, then remove `CMS_ALLOW_SETUP`.
   8. Afterwards delete those two Preview-scoped variables (and the project, if you like).
      Nothing was ever written to the school's database or bucket.

Never run against the school's project: `DROP`/`TRUNCATE`/`ALTER` of any kind, deleting or
re-creating the bucket, changing its settings, or `CMS_ALLOW_SETUP=1` in Production.
To check the one number this app cannot see — the bucket's own size limit — open the
school's project → Storage → `media` → settings and read **File size limit**. That is
read-only, and `0`/blank means unlimited.

## 5. After the database goes live: re-check the notice once

The public Notices page still shows the notice written in `notices.html` — it is a static
part of the approved design. As soon as the **first real notice is published** in the
dashboard, the page switches to the database list. So the very first thing to do after
setup is: **নোটিশ → + নতুন নোটিশ** → type the current notice → **প্রকাশ করুন**.
Until that happens, no school information is lost; the static content simply stays.

Nothing published is ever replaced by a later publication. The notices page, the exam
routine section and the routine section are shown a page at a time — 20 notices, 200 exam
rows, 40 routines — and when older records exist behind that page the page grows its own
**আরও পুরোনো নোটিশ দেখুন** / **আগের রুটিন দেখুন** button, which adds the older rows below
(or, for exams, above, since that list reads oldest-date-first). Each card the CMS adds is
marked with its row id, so the same record can never appear twice and no card already on
screen is thrown away when another page loads. The feeds behind them answer
`/api/public/<feed>?limit=…&offset=…` and report `has_more` / `next_offset`.

---

## Local development (no Supabase account needed)

```bash
cd tools
npm install          # jsdom only, for the test suites — nothing in the site needs it
npm run dev          # http://127.0.0.1:8000  (local JSON driver, .cms-data/)
```

The dev server uses the `local` driver: data goes to `.cms-data/` (git-ignored), so you can
click everything — uploads included — without a cloud account. `python3 -m http.server`
still serves the public site alone, but `/api` needs Node, so use `npm run dev`.

## URL shape rule (why actions are query parameters)

Vercel derives an API route from each file under `api/`: a folder catch-all
`api/<group>/[...path].mjs` answers `/api/<group>/<one-or-more segments>` and *not*
`/api/<group>` itself, while a top-level `api/media.mjs` answers exactly `/api/media`.
A URL outside that table never reaches any code — it 404s as a platform miss with an
HTML body, which the dashboard shows as "অনুরোধ ব্যর্থ (HTTP 404)" and an `<img>` shows
as a blank tile. So actions ride on the query string
(`POST /api/cms/notices?id=…&action=publish`), storage keys ride on
`/api/media?path=images/2026-10/<uuid>.jpg` (the entry file is `api/media.mjs`, one
level up, precisely because that is the URL `mediaUrl()` mints), and the older
`/resource/action` form still resolves for anything that already uses it.
`npm run test:routes` matches every minted URL against the real layout of `api/`, not
just its segment count — counting alone was fooled twice, once by `/api/media`.

## Tests

```bash
cd tools
npm test              # 87 API + security + dashboard checks (no npm packages needed)
npm run test:config   # 16 checks: service-role key validation + drivers vs schema.sql
npm run test:routes   # 19 checks: every URL is matched by a deployed file + lifecycles
npm run test:public   # 43 checks: the real pages render CMS content into the approved markup
npm run test:admin    # 22 checks: the teacher's actual clicks, end to end
npm run test:storage  # 13 checks: the upload grants and staging rules large photos rely on
npm run test:supabase # 25 checks: the same flow on the real Supabase driver, over loopback HTTP
```

They start a throwaway server against a temporary data folder and fail loudly if any
security rule or the public design's markup regresses.

## How content becomes visible

| Status | Meaning | Public site |
| --- | --- | --- |
| `খসড়া` (draft) | saved, not shown | no |
| `প্রকাশিত` (published) | live | yes |
| `অপ্রকাশিত` (unpublished) | was live, taken down | no |
| বাতিল ঘর (trash) | deleted, restorable | no |

Deleting never destroys anything immediately, and neither does editing: rows go to the
trash (restore or purge there), and clearing or swapping an attachment leaves the previous
file in storage rather than removing it, because an edit is not a delete. Stored objects are
only ever freed by an explicit purge, and even then only the ones no other row still
points at. Every create / publish / delete is written to `cms_audit` with the
account's email.

## What is *not* in the database

Barely anything: the hero, About, Academics, SSC results and analytics, admission and
contact details, the footer and all styling stay in the committed HTML/CSS, exactly as
approved. The database drives notices, exam routines, other routines and the gallery.
That split is deliberate — routine content changes weekly, the rest does not.
