This folder contains the Eleventy source content used to build the site.

Structure overview:

- `components/` — reusable Nunjucks templates, plus `base.njk`, the page shell
- `data/` — global data files (`site.js`, `team.js`, `locales.js`)
- `content/` — one template per page, plus `content.11tydata.js` (locale helpers)
- `assets/` — static assets (CSS, images, JS)
- `utils/` — utility functions and helpers
- `robots.txt` — robots rules included in build

Notes:

- Keep page content and templates inside `src/` to match Eleventy conventions.
- Use `npm start` to run the Eleventy dev server and `npm run build` for production output.
- Pages pull in the shell with `{% extends "base.njk" %}` / `{% block content %}`,
  not Eleventy's `layout:` front matter. See the comment at the top of
  `components/base.njk`, and "Bilingual pages" in the root `README.md`.
