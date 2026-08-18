# AI Safety Italia Website

A modern, minimal static website for AI Safety Italia - built with Eleventy, Tailwind CSS, and a comprehensive design token system.

## ✨ Features

- **Design Token System**: All visual properties (colors, fonts, spacing, animations) controlled via YAML files
- **Dark/Light Themes**: Fully configurable, CSS variable-based theme system with localStorage persistence
- **Modern Responsive Design**: Clean, minimal aesthetic using Tailwind CSS with mobile-first approach
- **Fast Performance**: Static site generation with Eleventy ensures minimal HTTP requests and fast load times
- **Easy Deployment**: Pre-configured for Vercel with zero-config deployment
- **Content Management**: Simple Markdown + YAML structure separates content from code and design
- **Component-Based Architecture**: Reusable Nunjucks templates reduce duplication and improve maintainability
- **SEO Optimized**: Semantic HTML, proper metadata, and dynamic title generation
- **Accessibility Focused**: Skip links, ARIA labels, keyboard navigation, and semantic HTML throughout
- **Data Validation**: Integrated validation for content and configuration files with clear error messages
- **Code Quality**: ESLint, Prettier, and Husky pre-commit hooks ensure consistent, professional code
- **Unified Utilities**: Centralized validation and helper functions with comprehensive JSDoc documentation

## Table of Contents

- [Quick Start](#quick-start)
- [Installation](#installation)
- [Development](#development)
- [Building](#building)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Bilingual Pages (EN / IT)](#bilingual-pages-en--it)
- [Design System](#design-system)
- [Content Management](#content-management)
- [Utilities & Validation](#utilities--validation)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [License](#license)

## Quick Start

```bash
# Install dependencies
npm install

# Start development server with live reload
npm start

# Build for production
npm run build

# Format code
npm run format

# Lint JavaScript
npm run lint
```

## Installation

1. Clone the repository

```bash
git clone https://github.com/AI-Safety-for-Italy/AIS_Italy_Website.git
cd AIS_Italy_Website
```

2. Install dependencies

```bash
npm install
```

3. **Windows Note**: You might need to adjust PowerShell execution policy:

```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```

## Development

Start the development server:

```bash
npm start
```

This will:
- Start a local server at `http://localhost:8080`
- Enable hot reload for HTML, CSS, and JavaScript changes
- Watch for CSS, design token, and data file changes
- Automatically rebuild on save

## Building

Build for production:

```bash
npm run build
```

This will:
- Clean the `_site/` output directory
- Build CSS with PostCSS and Tailwind
- Generate static HTML with Eleventy
- Output to `_site/` directory ready for deployment

## Project Structure

```
AIS_Italy_Website/
├── data/                         # Content data files (YAML) - Edit here for content changes
│   ├── home.yaml                 # Homepage content
│   ├── about.yaml                # About page content
│   ├── events.yaml               # Events page content
│   ├── activities.yaml           # Activities page content
│   ├── community.yaml            # Community page content
│   ├── faq.yaml                  # FAQ page content
│   ├── contact.yaml              # Contact page content
│   ├── global.yaml               # Shared content (navigation, footer, social)
│   └── AISafetyItaly.svg         # Logo
├── src/
│   ├── assets/                   # Static assets
│   │   ├── css/
│   │   │   └── style.css          # Main stylesheet (Tailwind + custom CSS)
│   │   ├── img/                   # Images and icons
│   │   └── js/
│   │       └── main.js            # Menu, theme toggle, scroll reveal, pointer FX
│   │                              # (deferred, cached across pages)
│   ├── components/               # Reusable Nunjucks components
│   │   ├── header.njk            # Site header with theme toggle
│   │   ├── footer.njk            # Site footer
│   │   ├── hero.njk              # Hero section
│   │   ├── cta.njk               # Call-to-action component
│   │   ├── event-card.njk        # Event card component
│   │   ├── features.njk          # Features list
│   │   ├── stats.njk             # Statistics display
│   │   ├── icons.njk             # SVG icon definitions
│   │   ├── style-guide.njk       # Style guide component
│   │   └── sections/             # Complex section components
│   │   └── base.njk              # Page shell: <head>, SEO, JSON-LD, header/footer
│   ├── content/                  # Page content (one .njk per page)
│   │   ├── index.md              # Homepage
│   │   ├── about.md              # About page
│   │   ├── community.md          # Community page
│   │   ├── contact.md            # Contact page
│   │   ├── events.md             # Events page
│   │   ├── faq.md                # FAQ page
│   │   └── style-guide.md        # Style guide
│   ├── design/                   # Design tokens (YAML) ⭐
│   │   ├── colors.yaml           # Color palette
│   │   ├── themes.yaml           # Light/dark theme definitions
│   │   ├── typography.yaml       # Font families and text scales
│   │   ├── spacing.yaml          # Spacing scale
│   │   ├── components.yaml       # Component styles
│   │   ├── layout.yaml           # Grid, breakpoints, animations
│   │   ├── design.yaml           # Main design config
│   │   └── README.md             # Design system documentation
│   ├── data/                     # Dynamic data files
│   │   ├── site.js               # Site config and navigation (with validation)
│   │   ├── team.js               # Team member data (with validation)
│   │   └── content.js            # Content data loader
│   ├── utils/                    # Utility functions
│   │   ├── validation.js         # Unified validation utilities ⭐ NEW
│   │   ├── helpers.js            # Client-side helper functions
│   │   └── contentValidation.js  # Content schema validation
│   ├── README.md                 # Source directory documentation
│   └── robots.txt                # SEO robots directive
├── _site/                        # Build output (generated, ignored in git)
├── .eleventy.js                  # Eleventy configuration
├── .eslintrc.cjs                 # ESLint rules
├── .prettierrc                   # Prettier configuration
├── .gitignore                    # Git ignore patterns
├── tailwind.config.js            # Tailwind CSS configuration
├── postcss.config.js             # PostCSS configuration
├── vercel.json                   # Vercel deployment config
├── package.json                  # Project dependencies
├── Agent.md                      # AI agent guide and architecture overview
├── README.md                     # This file
├── ModificationGuide.md          # Content editing guide for non-technical users
├── CONTRIBUTING.md               # Contribution guidelines
└── LICENSE                       # MIT License
```

## Architecture

### Technology Stack

- **Static Site Generator**: Eleventy (11ty) - Fast, minimal build tool
- **Styling**: Tailwind CSS with custom CSS and design tokens
- **CSS Processing**: PostCSS with autoprefixer
- **Templating**: Nunjucks
- **Content Format**: Markdown + YAML
- **Validation**: AJV for schema-based validation
- **Code Quality**: ESLint, Prettier, Husky
- **Deployment**: Vercel

### Design Principles

1. **Separation of Concerns**: Code, design, and content are clearly separated
2. **Single Source of Truth**: Design tokens in YAML are the single source for all visual properties
3. **Configuration Over Code**: Prefer configuration files (YAML) over hardcoding values
4. **DRY (Don't Repeat Yourself)**: Reusable components and utilities prevent duplication
5. **Accessibility First**: Semantic HTML, ARIA labels, keyboard navigation built-in
6. **Mobile First**: Responsive design starts with mobile-size base
7. **Performance**: Static generation, minimal CSS, optimized assets

## Bilingual Pages (EN / IT)

Every page is published twice as real, crawlable HTML: English at `/about/` and
Italian at `/it/about/`. There is no client-side language swap — the URL is the
language, so search engines can index the Italian content and `hreflang` points
at pages that actually exist.

### How a page becomes bilingual

`src/data/locales.js` lists the locales. A page opts in through its front matter:

```yaml
---
title: About Us
basePath: /about/          # locale-independent path
pagination:
  data: locales
  size: 1
  alias: locale
  addAllPagesToCollections: true   # so both locales reach the sitemap
permalink: '{{ locale.prefix }}{{ basePath }}'
seoTitle: 'About AI Safety for Italy'
seoTitle_it: 'Chi siamo | AI Safety for Italy'
seoDescription: '…'
seoDescription_it: '…'
---
{% extends "base.njk" %}
{% block content %}…{% endblock %}
```

`basePath` is the single source of truth for the page's URL: the permalink, the
`hreflang` alternates, the sitemap entry and the header's language switch are all
derived from it. A page with no `basePath` (the style guide) stays English-only
and gets no language switch.

### How the text gets translated

Templates keep authoring both languages inline, exactly as before:

```html
<h2 data-en="Get in touch" data-it="Contattaci">Get in touch</h2>
<input placeholder="Your name" data-placeholder-en="Your name" data-placeholder-it="Il tuo nome">
```

At build time the `localize` transform in `.eleventy.js` resolves each pair down
to one language, rewrites internal links to stay inside `/it/`, and strips the
`data-*` attributes so no page ships both languages. Two rules:

- The element must contain **text only** — the translation replaces its whole
  content. One wrapping other markup is left in English and reported in the
  build log.
- An **empty** `data-it` falls back to the English text, so partially translated
  data (for example `role_it` in `src/data/team.js`) is safe to add gradually.

For strings the build has to resolve itself — `aria-label`, `title` — use `t`,
which is already the active language: `aria-label="{{ t.a11y.open_menu }}"`.

### Adding a locale

Add an entry to `src/data/locales.js`, add the matching `data-<code>` attributes
(or `*_<code>` YAML fields), and add a `translations.<code>` block. The permalinks,
`hreflang` set, sitemap and language switch all follow automatically.

> **Note:** pages use Nunjucks `{% extends %}` rather than Eleventy's `layout:`
> front matter. Eleventy 2.0.1 throws `Cannot assign to read only property
> 'content'` when a template uses `layout:` together with `pagination`, and every
> localized page is paginated over `locales`. Upgrading Eleventy would remove that
> constraint.

## Theme System

The website features a sophisticated **CSS variable-based theme system** enabling seamless light/dark mode switching.

### How It Works

- **Architecture**: CSS variables declared in `:root` for light theme (default)
- **Dark Variant**: `[data-theme='dark']` attribute on document element overrides variables
- **Theme Toggle**: Button in header; persists user preference in localStorage
- **No flash**: a small inline script in `<head>` reads the saved theme and sets
  `data-theme` **before the first paint**. It has to stay inline and stay in the
  head — deferred or moved to the end of `<body>` it becomes a white flash on
  every visit, because the default theme (`themes.yaml` → `dark.isDefault`) is
  dark. The toggle's click handler lives in `assets/js/main.js`
- **Icon**: both icons are in the markup and CSS picks one off `[data-theme]`, so
  the icon cannot flash either — JS never assigns it
- **Coverage**: 40+ CSS variables per theme ensure uniform styling
- **Readability**: Text colors automatically adjust for contrast (dark text on light, light text on dark)
- **Variables**: All colors, backgrounds, borders, and shadows use CSS variables
- **Performance**: No JavaScript repaints - pure CSS solution

### CSS Variables Example

```css
:root {
  /* Light theme (default) */
  --bg-primary: #ffffff;
  --bg-secondary: #f8fafc;
  --text-primary: #0f1727;
  --text-secondary: #64748b;
  --accent: #0369a1;
  --text-primary: #f8fafc;
  --accent: #38bdf8;
  --card-bg: #1e293b;
  /* ... 40+ more variables */
}


### Design Token Files

| File              | Purpose           | Example                             |
| ----------------- | ----------------- | ----------------------------------- |
| `design.yaml`     | Main settings     | Border radius, shadows, transitions |
| `colors.yaml`     | Color palette     | Brand colors, semantic colors       |
| `themes.yaml`     | Light/Dark themes | Theme colors, toggle icons          |
| `typography.yaml` | Fonts & text      | Font families, sizes, weights       |
| `spacing.yaml`    | Layout spacing    | Margins, paddings, gaps             |
| `components.yaml` | Component styles  | Buttons, cards, navigation          |
| `layout.yaml`     | Layout config     | Grids, breakpoints, animations      |

### Quick Design Changes

**Important**: All color changes should be made in `src/design/themes.yaml` so that both light and dark themes are updated simultaneously.

#### Change Brand Colors

Edit `src/design/colors.yaml` and `src/design/themes.yaml`:

```yaml
# In colors.yaml - used for reference
colors:
  brand:
    primary: '#0369a1'      # Light mode blue
    primaryDark: '#38bdf8'  # Dark mode blue

# In themes.yaml - the active variables
light:
  css:
    --accent: '#0369a1'     # Light theme primary color

dark:
  css:
    --accent: '#38bdf8'     # Dark theme primary color
```

#### Change Theme Colors (Most Common)

Edit `src/design/themes.yaml` - this is the primary source for light/dark mode colors:

```yaml
light:
  css:
    --bg-primary: '#ffffff'      # Light background
    --text-primary: '#0f1727'    # Dark text
    --card-bg: '#f8fafc'         # Card background
    # ... 40+ more variables

dark:
  css:
    --bg-primary: '#0f172a'      # Dark background
    --text-primary: '#f8fafc'    # Light text
    --card-bg: '#1e293b'         # Dark card background
    # ... 40+ more variables
```

For complete design system documentation, see `src/design/README.md`.

## Utilities & Validation

### Validation Module (`src/utils/validation.js`)

Centralized validation utilities used throughout the codebase for data validation and consistency.

**Key Functions**:

```javascript
// Email and URL validation
isValidEmail(email)  // Returns: boolean
isValidUrl(url)      // Returns: boolean

// Type checking
isRequired(value, fieldName)        // Returns: { valid, error }
isArray(value, fieldName)           // Returns: { valid, error }
isString(value, fieldName)          // Returns: { valid, error }

// Multi-field validation
hasRequiredFields(obj, fields)      // Returns: { valid, errors }

// Data structure validation
validateTeamMember(member)          // Returns: { valid, errors }
validateSiteData(data)              // Returns: { valid, errors }

// Error reporting
logValidationErrors(section, errors, level)  // Logs formatted errors
```

**Usage Example**:

```javascript
const { isValidEmail, hasRequiredFields } = require('./validation.js');

// Validate email
if (isValidEmail('user@example.com')) {
  console.log('Valid email');
}

// Validate multiple required fields
const result = hasRequiredFields(user, ['name', 'email', 'role']);
if (!result.valid) {
  logValidationErrors('user data', result.errors);
}
```

### Helper Functions (`src/utils/helpers.js`)

Client-side utilities for DOM manipulation, notifications, and performance optimization.

**Key Functions**:

```javascript
// User notifications (auto-dismiss)
showNotification(message, type, duration)
// Types: 'info', 'success', 'warning', 'error'

// XSS protection
sanitizeInput(str)  // Safe HTML escaping

// Performance optimization
debounce(func, wait, immediate)    // Rate limit execution
throttle(func, limit)              // Execute at intervals

// DOM utilities
isElementInViewport(element)       // Check visibility
```

**Usage Example**:

```javascript
// Show success notification
showNotification('Form submitted successfully!', 'success');

// Debounce search input
const debouncedSearch = debounce(searchAPI, 300);
input.addEventListener('input', debouncedSearch);
```

## Content Management

### For Non-Technical Users

For instructions on safely editing content and design, see our [Content Modification Guide](ModificationGuide.md).

**Content Files** (`/data`):

- `home.yaml` - Homepage content
- `about.yaml` - About page content
- `events.yaml` - Events page content
- `activities.yaml` - Activities page content
- `community.yaml` - Community page content
- `faq.yaml` - FAQ content
- `contact.yaml` - Contact page content
- `global.yaml` - Navigation, footer, social links

**Design Files** (`/src/design`):

- All visual styles (colors, fonts, spacing, animations, component styles)

### For Technical Users

- **Edit pages**: `src/content/` (Markdown)
- **Update content**: `/data/` (YAML)
- **Update design**: `src/design/` (YAML)
- **Site config**: `src/data/site.js` (with validation)
- **Team info**: `src/data/team.js` (with validation)
- **Utilities**: `src/utils/` 
- **Components**: `src/components/`
- **Page shell**: `src/components/base.njk`
- **Locales**: `src/data/locales.js`

### Community Directory (`data/members.yaml`)

The member table on the Community page is generated, not hand-edited. Running

```bash
pip install -r scripts/requirements.txt   # one-off
python3 scripts/update-members.py
```

downloads the registration form's response sheet and rewrites
`data/members.yaml`. A daily GitHub Action
(`.github/workflows/update-members.yml`) does the same and pushes the result to
the `chore/update-members` branch, so new sign-ups reach the site without
anyone exporting a spreadsheet.

The Action pushes a branch rather than opening a pull request because this
organisation does not allow GitHub Actions to create PRs. Opening it is one
click: the run summary lists who joined and who left, and links to the compare
page. The Action refuses to run if someone has committed to that branch by
hand, rather than force-pushing over their work.

Two things to know before editing that file by hand — the next sync overwrites it:

- **Consent.** Sign-ups from 2026-06-30 onward appear only if they ticked the
  publication-consent question. Earlier sign-ups predate that question and are
  grandfathered in, which depends on the timestamp parsing correctly.
- **Removals.** The script writes the sheet's current state, so people
  disappear when their row leaves the sheet. That is why the Action opens a PR
  rather than committing straight to `main` — read the diff.

**If the sync fails, the current directory stays put.** `members.yaml` is only
replaced once a full, sane result has been rendered, so a bad run leaves the
site exactly as it was. The script aborts with a non-zero exit — failing the
Action and opening no pull request — when:

- the sheet cannot be downloaded, or answers with a sign-in page instead of CSV
  (which is what a sheet that stopped being link-readable looks like);
- a column the parser needs has been renamed in the form;
- the export has no rows, or yields no publishable members;
- the run would remove more than 25% of the published directory, which is far
  more often a parsing break than a real exodus. Re-run with `--force` once
  you have confirmed the removal is genuine.

`last_updated` only moves when the roster actually changes, so an unchanged day
produces no diff and no pull request.

Pass `--local` to read the newest export in `data/` instead of the live sheet,
or `--file PATH` for a specific `.xlsx`/`.csv`.

The parser is covered by `scripts/test_update_members.py`, which CI runs on
every pull request:

```bash
npm test
```

Two repository settings this depends on:

- The sync needs no special permissions beyond `contents: write`, which the
  workflow requests for itself. It deliberately does not depend on *"Allow
  GitHub Actions to create and approve pull requests"*, which is disabled here
  and only an organisation admin can change.
- GitHub **disables scheduled workflows after 60 days without repository
  activity**, without notice. If the repo goes quiet, re-enable the workflow
  from the Actions tab — the sync stops silently otherwise.

### Data Validation

The project includes integrated validation for site configuration and team data:

**Site Configuration** (`src/data/site.js`):
- Validates site name, description, domain, contact email
- Validates navigation structure
- Validates social media links
- Validates external form URLs
- Provides detailed error messages on validation failure

**Team Data** (`src/data/team.js`):
- Validates team member structure (name, role, bio, email)
- Supports email addresses and URLs for member links
- Provides per-member error reporting
- Non-blocking validation (site works even if some validation fails)

**Content Validation** (`src/utils/contentValidation.js`):
- Schema-based validation using AJV
- Validates content structure for each page section
- Ensures required fields and proper data types

## Code Quality

### Code Standards

The project maintains high code quality through:

- **ESLint**: JavaScript linting with recommended rules
- **Prettier**: Automatic code formatting (100 char line width, 2-space indent)
- **Husky**: Git hooks for pre-commit checks
- **Lint-Staged**: Lint only staged files for efficiency
- **JSDoc**: Comprehensive documentation for all functions

### Running Quality Checks

```bash
# Format all files
npm run format

# Check formatting without changes
npm run format:check

# Lint JavaScript with auto-fix
npm run lint

# Pre-commit hook (automatic)
# Runs: lint, format, ESLint check
```

### JavaScript Best Practices

- Comprehensive JSDoc documentation for all public functions
- Parameter and return type annotations
- Error handling with meaningful error messages
- Validation of all inputs
- Clear, descriptive variable and function names
- No dead code or commented-out blocks
- Environment detection for browser/server contexts

## Housekeeping

```bash
# Clean build outputs
npm run clean

# Format repository
npm run format

# Check formatting
npm run format:check

# Lint JavaScript (with auto-fix)
npm run lint

# Debug Eleventy (verbose output)
npm run debug
```

**Configuration files:**

- `.prettierrc` — Prettier code formatting rules
- `.eslintrc.cjs` — ESLint linting rules
- `.gitignore` — Git ignore patterns
- `.eleventy.js` — Eleventy configuration
- `tailwind.config.js` — Tailwind CSS configuration
- `postcss.config.js` — PostCSS configuration

## Deployment

### Vercel (Recommended)

1. Push to GitHub
2. Connect repository to Vercel
3. Vercel will automatically build and deploy on push

### Manual Deployment

1. Build: `npm run build`
2. Deploy the `_site/` folder to your hosting

## Contributing

We welcome contributions! Please see our [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Environment Variables

No environment variables required. Google Forms URLs are configured in `src/data/site.js`.

## Technology Stack

- **Static Site Generator**: Eleventy (11ty)
- **CSS Framework**: Tailwind CSS
- **PostCSS**: CSS processing
- **Templating**: Nunjucks
- **Design Tokens**: YAML-based system
- **Deployment**: Vercel

## License

MIT

## Support

For questions or contributions, contact: aisafetyitalia@gmail.com

## Documentation

- [Agent Configuration](Agent.md) - Technical documentation for AI agents
- [Modification Guide](ModificationGuide.md) - Content and design editing guide
- [Design System Docs](src/design/README.md) - Design token documentation
