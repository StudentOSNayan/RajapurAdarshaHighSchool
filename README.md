# Rajapur Adarsha High School

A lightweight, static official website for **Rajapur Adarsha High School** in Rajapur, Ramshil, Kotalipara, Gopalganj, Bangladesh.

## Stack

- Plain HTML, CSS and vanilla JavaScript
- No framework, build step or third-party UI library
- Responsive layout with Bengali-friendly typography
- Accessible mobile navigation and photo gallery lightbox

## Pages

| Page | File | Purpose |
| --- | --- | --- |
| Home | `index.html` | Compact hero, current notice, quick access, notices, events, contact |
| About | `about.html` | School introduction, history/mission scope, head teacher, office |
| Academics | `academics.html` | Published academic information and office guidance |
| Admission | `admission.html` | Direct route to current admission information from the office |
| Notices & News | `notices.html` | Separate official notices and school news/events |
| Gallery | `gallery.html` | Curated, filterable photo collection with accessible lightbox |
| Contact | `contact.html` | Address, office hours and school phone numbers |

## Published information

The website limits content to details available for publication:

- School name: Rajapur Adarsha High School / রাজাপুর আদর্শ উচ্চ বিদ্যালয়
- Address: রাজাপুর, রামশীল, কোটালীপাড়া, গোপালগঞ্জ, বাংলাদেশ
- Office: 10:00 AM – 4:00 PM
- Head Teacher: Sopon Kumar Adhikary
- Official notice: model test examinations for all classes begin on 20 September 2026
- Documented events: Annual Sports Competition & Cultural Program (28–29 January 2026), Educational Tour to Bagerhat (28 April 2026), tree-planting and football activities
- Five school contact numbers on the Contact page

## Photos

The public gallery uses a curated set of optimized WebP images in `assets/img/`. Category metadata powers the filters, so the same physical photo is not duplicated for separate categories.

## Run locally

No installation is required:

```bash
python3 -m http.server 8080 --bind 0.0.0.0
```

Then open `http://localhost:8080`.

## Deployment

The site can be deployed directly as a static site on Vercel. No build command or output directory is needed.
