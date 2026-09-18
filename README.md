# Rajapur Adarsha High School — Official Website (v2)

Static, multi-page, **Modern Minimal** official website for **Rajapur Adarsha High School**, Rajapur, Kotalipara, Gopalganj, Bangladesh.

- **Stack:** pure HTML + CSS + vanilla JS. No framework, no build step, no dependencies.
- **Design:** mobile-first, premium modern-minimal — deep emerald + restrained gold, Manrope + Hind Siliguri, hairline borders, subtle motion (respects `prefers-reduced-motion`).
- **Honest placeholders:** every unverified detail is visibly marked **“To be confirmed”**. No EIIN, fees, staff list, stats or history are invented.
- **Photos:** real school photos only (supplied by the school). No AI/fake images.

## Pages (7)

| Page | File | Contents |
|---|---|---|
| Home | `index.html` | Hero (main building), latest-notice bar, about preview, recent events, clubs, CTA |
| About | `about.html` | Head teacher's message, history / mission / vision, school-life photos, office |
| Academics | `academics.html` | Class 6–8 / 9–10, Dhaka Board, academic facts (TBC) |
| Notices | `notices.html` | Model test 2026 (current), event reports, clearly-marked sample cards |
| Admission | `admission.html` | 3-step process + admission facts (TBC) |
| Contact | `contact.html` | Address, office hours, school contacts, approximate map |
| Not found | `404.html` | Matching 404 |

## Files

```
index.html / about.html / academics.html / notices.html / admission.html / contact.html / 404.html
assets/css/style.css    Single stylesheet — edit colors in :root
assets/js/main.js       Menu, scroll reveal, back-to-top, image fallback, year
assets/img/*.webp       Optimized real school photos (originals kept locally in originals/, gitignored)
favicon.svg             RA monogram
.nojekyll               Plain static serving (GitHub Pages)
.gitignore              Keeps repo clean
```

## Verified facts published on the site
- Names: **Rajapur Adarsha High School** / **রাজাপুর আদর্শ উচ্চ বিদ্যালয়**
- Address: **Rajapur, Ramshil, Kotalipara, Gopalganj, Bangladesh**
- **Classes Six to Ten**, **Dhaka Board**
- **Office hours 10:00 AM – 4:00 PM**
- **Head Teacher: Sopon Kumar Adhikary** (message as provided)
- History / mission / vision (as provided, with English translations)
- Clubs: Computer Club, Football Tournament, Cricket Tournament
- Current notice: model test for all classes from 20 September 2026
- Documented events (from school photo records): Annual Sports Competition & Cultural Program (28–29 Jan 2026), Educational Tour to Bagerhat (28 Apr 2026)
- School contact numbers (names as provided — no roles assigned)

**Still “To be confirmed”:** EIIN, established year, medium of instruction, motto, achievements, email, staff list, fees, admission dates, subjects/groups, tree-planting date.

## How to update (2 minutes each)
- **Any TBC fact:** search the page for `To be confirmed` and replace the badge with the verified value.
- **New notice:** copy a `.notice-card` block in `notices.html` — chips + date + title + text.
- **New photo:** drop originals into `originals/` (local only), save an optimized copy (WebP, ≤ 1400 px wide, ~60–150 KB) to `assets/img/`, then reference it in a `<figure class="photo">`.
- **Colors:** edit `:root` variables in `assets/css/style.css` only.

## Run locally
No install needed:

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

## Deploy
- **Vercel:** import the repo (or drag the folder) — framework preset “Other”.
- **GitHub Pages:** Settings → Pages → Deploy from branch → `main` / `(root)`.
