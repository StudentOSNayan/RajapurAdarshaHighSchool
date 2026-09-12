# Rajapur Adarsha High School — Official Website (v1)

Static, lightweight official website for **Rajapur Adarsha High School, Rajapur, Bangladesh**.

- Live URL after Pages setup: `https://studentosnayan.github.io/RajapurAdarshaHighSchool/`
- Stack: pure HTML + CSS + vanilla JS. No framework, no build step, no dependencies.
- All unverified information is visibly marked **“To be confirmed”**. No EIIN, address, phone, staff, history, or stats are invented.

## Files (8 total, < 100 KB)

```
index.html              Main one-page site (About, Academics, Notices, Campus, Admission, Contact)
404.html                Styled not-found page for GitHub Pages
favicon.svg             Temporary RAHS monogram (replace with official logo when available)
assets/css/style.css    All styles — edit colors in :root
assets/js/main.js       Mobile menu + header + year only
.nojekyll               Tells GitHub Pages to serve as plain static files
.gitignore              Keeps repo clean
README.md               This guide
```

## How to edit (2 minutes each)

- **School name (Bangla spelling):** search `EDIT: Verify Bangla spelling` in `index.html`. Confirm with school authority.
- **Logo:** replace the inline SVG monogram in header (`<!-- Temporary monogram -->`) + `favicon.svg` with official crest. Keep file names to avoid breaking Pages.
- **Contact:** find `<!-- EDIT: Fill in verified contact details -->` — replace each `To be confirmed` one by one.
- **Notices:** find `<!-- EDIT: Replace all 3 sample notices -->` — keep format: Date | Title | 2 lines.
- **Photos:** put 1–6 JPG/WebP files (<200 KB each) in `assets/img/`, replace `.tile` divs in `#campus` with `<img src="assets/img/xxx.jpg" alt="..." loading="lazy">`. Hero intentionally uses CSS (no photo needed).
- **Academics / Admission:** all placeholder blocks have `<!-- EDIT: ... -->` comments.

Rule: never remove a `To be confirmed` badge until the school authority verifies that fact.

## Run locally

No install needed:

```bash
cd RajapurAdarshaHighSchool
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy to GitHub Pages

1. Merge this branch to `main` via pull request.
2. On GitHub: **Settings → Pages → Deploy from branch → `main` / `(root)`** → Save.
3. Wait ~1 minute, open the Pages URL above.

Custom domain later (optional): add `CNAME` file + DNS record. No code change needed.

## v1 scope

Included: one-page premium responsive site, honest placeholders, SEO basics, accessibility basics.
Not in v1 (on purpose): multi-page expansion, Bangla/English toggle, contact-form backend, portal, admin panel.
