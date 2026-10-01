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

Check it worked: open `https://<your-domain>/api/public/health`.
You should get JSON with `"configProblems": []`. If the list is not empty, it names
exactly what is missing (typical mistake: the `anon` key pasted instead of the
`service_role` one — the API refuses that and says so).

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
| `CMS_MAX_IMAGES_PER_UPLOAD` | `6` | Per upload — Vercel Hobby functions stop at 10 s |
| `CMS_SESSION_HOURS` | `12` | Sliding session lifetime |
| `CMS_LOGIN_MAX_FAILS` / `CMS_LOGIN_WINDOW_MINUTES` | `8` / `15` | Per-IP+email lockout |
| `CMS_PUBLIC_CACHE_SECONDS` | `60` | CDN cache for `/api/public/*` |

## 5. After the database goes live: re-check the notice once

The public Notices page still shows the notice written in `notices.html` — it is a static
part of the approved design. As soon as the **first real notice is published** in the
dashboard, the page switches to the database list. So the very first thing to do after
setup is: **নোটিশ → + নতুন নোটিশ** → type the current notice → **প্রকাশ করুন**.
Until that happens, no school information is lost; the static content simply stays.

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

## Tests

```bash
cd tools
npm test             # 55 API + security + dashboard checks (no npm packages needed)
npm run test:public  # 18 checks: the real pages render CMS content into the approved markup
npm run test:admin   # 12 checks: the teacher's actual clicks, end to end
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

Deleting never destroys anything immediately: rows go to the trash (restore or purge
there), photo files are removed from storage only when a row is purged or an album is
deleted for good. Every create / publish / delete is written to `cms_audit` with the
account's email.

## What is *not* in the database

Barely anything: the hero, About, Academics, SSC results and analytics, admission and
contact details, the footer and all styling stay in the committed HTML/CSS, exactly as
approved. The database drives notices, exam routines, other routines and the gallery.
That split is deliberate — routine content changes weekly, the rest does not.
