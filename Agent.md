# AI Safety Italia Website - Agent Configuration & Refactoring Guide

## Overview

This document describes the AI Safety Italia Website project and provides comprehensive guidance for AI agents and developers working with the codebase. It includes recent refactoring improvements and architectural details.

## Project Information

- **Name**: AI Safety Italia Website
- **Purpose**: A modern, minimal static website for AI Safety Italia - built with Eleventy and Tailwind CSS
- **Technology Stack**: Eleventy, Tailwind CSS, PostCSS, JavaScript (Node.js), YAML (design tokens)
- **Repository**: AIS Italy Website
- **Build Type**: Static Site Generation
- **Features**: Dark/light mode toggle, design token system, responsive design, content separation, validation utilities

## Architecture Overview

### Technology Stack Details

- **Static Site Generator**: Eleventy (11ty) v2.0.1
- **CSS Framework**: Tailwind CSS v3.3.0
- **CSS Processing**: PostCSS with autoprefixer
- **Templating Engine**: Nunjucks (`.njk`)
- **Content Format**: Markdown (`.md`) and YAML (`.yaml`)
- **Design System**: YAML-based design tokens with CSS variables
- **Validation**: Integrated AJV for schema-based validation
- **Code Quality**: ESLint, Prettier, Husky pre-commit hooks
- **Deployment**: Vercel

### Directory Structure

```
AIS Italy Website/
├── data/                       # Content data files (non-technical users)
│   ├── home.yaml              # Homepage content
│   ├── about.yaml             # About page content
│   ├── events.yaml            # Events page content
│   ├── activities.yaml        # Activities page content
│   ├── community.yaml         # Community page content
│   ├── faq.yaml               # FAQ page content
│   ├── contact.yaml           # Contact page content
│   ├── global.yaml            # Shared content (nav, footer, social)
│   └── AISafetyItaly.svg      # Logo asset
├── src/
│   ├── assets/
│   │   ├── css/
│   │   │   └── style.css      # Main stylesheet with Tailwind & custom CSS
│   │   ├── img/               # Images and icons
│   │   │   ├── favicon.svg
│   │   │   ├── AISafetyItaly.svg
│   │   │   ├── ais_italy_light_bg.png
│   │   │   └── ais_italy_dark_bg.png
│   │   ├── js/                # Client-side JavaScript
│   │   └── fonts/             # Custom web fonts
│   ├── components/
│   │   ├── header.njk         # Site header with theme toggle
│   │   ├── footer.njk         # Site footer
│   │   ├── hero.njk           # Hero section component
│   │   ├── cta.njk            # Call-to-action component
│   │   ├── event-card.njk     # Event card component
│   │   ├── features.njk       # Features list component
│   │   ├── stats.njk          # Statistics component
│   │   ├── icons.njk          # Icon definitions (SVG)
│   │   ├── style-guide.njk    # Style guide component
│   │   └── sections/          # Complex section components
│   │       ├── hero.njk
│   │       ├── features.njk
│   │       └── stats.njk
│   ├── data/
│   │   ├── site.js            # Site configuration & validation
│   │   ├── team.js            # Team member data & validation
│   │   └── content.js         # Content data loader
│   ├── design/
│   │   ├── design.yaml        # Main design config
│   │   ├── colors.yaml        # Color palette & semantic colors
│   │   ├── themes.yaml        # Light/dark theme definitions
│   │   ├── typography.yaml    # Font families, sizes, styles
│   │   ├── spacing.yaml       # Margins, paddings, gap values
│   │   ├── components.yaml    # Component-specific styles
│   │   ├── layout.yaml        # Grid, breakpoints, animations, z-index
│   │   └── README.md          # Design system documentation
│   │   └── base.njk           # Page shell: head/SEO/JSON-LD + theme system.
│   │                          # Pages use {% extends "base.njk" %}, NOT layout:
│   ├── content/
│   │   ├── index.md           # Homepage entry
│   │   ├── about.md           # About page
│   │   ├── community.md       # Community page
│   │   ├── contact.md         # Contact page
│   │   ├── events.md          # Events page
│   │   ├── faq.md             # FAQ page
│   │   └── style-guide.md     # Style guide
│   ├── utils/
│   │   ├── helpers.js         # Client-side utility functions
│   │   ├── validation.js      # Unified validation utilities (NEW)
│   │   └── contentValidation.js # Content schema validation
│   ├── README.md              # Source directory documentation
│   └── robots.txt             # SEO robots directive
├── _site/                      # Build output (generated, not in git)
├── .eleventy.js               # Eleventy configuration
├── .eslintrc.cjs              # ESLint configuration
├── .prettierrc                # Prettier configuration
├── .gitignore                 # Git ignore rules
├── tailwind.config.js         # Tailwind CSS configuration
├── postcss.config.js          # PostCSS configuration
├── vercel.json                # Vercel deployment config
├── package.json               # Project dependencies
├── Agent.md                   # This file
├── README.md                  # Main project documentation
├── ModificationGuide.md       # Content editing guide for non-technical users
└── CONTRIBUTING.md            # Contribution guidelines

```

## Recent Refactoring & Improvements (2026)

### Code Quality Improvements

1. **Unified Validation Module** (`src/utils/validation.js`)
   - Consolidated email validation logic from multiple files
   - Created comprehensive validation utilities: `isValidEmail()`, `isValidUrl()`, `isRequired()`, `isArray()`, `isString()`, `hasRequiredFields()`
   - Provides consistent validation across data files
   - Eliminates code duplication
   - Proper error handling with detailed error messages
   - Full JSDoc documentation for all functions

2. **Enhanced Helper Functions** (`src/utils/helpers.js`)
   - Added comprehensive JSDoc documentation
   - Improved error handling and input validation
   - Added new utility functions: `throttle()`, `isElementInViewport()`
   - Enhanced `showNotification()` with duration control and dismissal
   - Better environment detection (browser vs Node.js)
   - Complete parameter validation with meaningful error messages

3. **Optimized Configuration Files**
   - `.eleventy.js`: Refactored data loading with helper function to reduce duplication
   - Added watch target for `data/` directory for live reload
   - Better error messages for missing data files
   - Cleaner global data setup using array-based configuration
   - Improved comments and JSDoc documentation

4. **Code Organization**
   - `src/data/site.js`: Now uses unified validation module
   - `src/data/team.js`: Refactored with improved validation
   - Removed duplicate email validation functions across files
   - Consistent error logging across all data files

### New Files Created

- **`src/utils/validation.js`**: Unified validation utilities (250+ lines with documentation)
- **`data/activities.yaml`**: Missing activities page content (created to match .eleventy.js configuration)
- **`.prettierrc`**: Prettier configuration for consistent code formatting
- **`.gitignore`**: Enhanced with comprehensive ignore patterns

### Configuration Enhancements

- **`.gitignore`** additions:
  - package-lock.json, yarn.lock
  - IDE and editor files (.vscode, .idea)
  - Testing and temporary files
  - Enhanced OS file exclusions

- **Prettier Configuration** (`.prettierrc`):
  - Print width: 100 characters
  - Tab width: 2 spaces
  - Single quotes for JavaScript
  - Trailing commas: ES5 style
  - Bracket spacing enabled
  - LF line endings

## Utility Modules

### Validation Module (`src/utils/validation.js`)

**Purpose**: Centralized validation for email, URLs, data structures, and site/team data.

**Key Functions**:
- `isValidEmail(email)`: Validates email format
- `isValidUrl(url)`: Validates URL format
- `isRequired(value, fieldName)`: Checks required fields
- `isArray(value, fieldName)`: Type checking for arrays
- `isString(value, fieldName)`: Type checking for strings
- `hasRequiredFields(obj, requiredFields)`: Multi-field validation
- `validateTeamMember(member)`: Team member structure validation
- `validateSiteData(data)`: Complete site data validation
- `logValidationErrors(section, errors, level)`: Formatted error logging

**Error Handling**:
- Returns structured objects with `{ valid, errors/error }` format
- Provides descriptive error messages for each validation failure
- Supports different log levels (warn, error, info)

### Helpers Module (`src/utils/helpers.js`)

**Purpose**: Client-side utilities for DOM manipulation, notifications, and performance optimization.

**Key Functions**:
- `sanitizeInput(str)`: XSS protection via DOM API
- `showNotification(message, type, duration)`: User notifications (info, success, warning, error)
- `debounce(func, wait, immediate)`: Function execution rate limiting
- `throttle(func, limit)`: Throttled function execution at intervals
- `isElementInViewport(element)`: Viewport visibility detection

**Features**:
- Environment detection (browser vs server)
- Full error handling and validation
- Accessibility support (ARIA attributes)
- Auto-dismissal with manual click to close
- Memory-safe DOM manipulation

### Content Validation Module (`src/utils/contentValidation.js`)

**Purpose**: Schema-based validation for page content using AJV.

**Schemas Defined**:
- `home`: Homepage content structure
- `about`: About page structure
- Additional schemas for other page sections

**Functions**:
- `validateContentData(section, data)`: Validates against schema
- `logValidationErrors(section, errors)`: Logs validation results

## Data Files & Validation

### Site Configuration (`src/data/site.js`)

**Purpose**: Centralized site metadata and navigation configuration.

**Data Structure**:
```
site:
  name: Site name
  description: SEO description
  domain: Distribution domain
  email: Contact email

navigation: Array of nav items { name, url, dropdown }
social: Social media links { linkedin, discord, etc. }
forms: External form URLs { mailingList, courseApplication }
```

**Validation**: Integrated validation on module load
- Validates required fields via unified validation module
- Logs validation errors to console
- Non-blocking (site continues to work even with validation errors)

### Team Data (`src/data/team.js`)

**Purpose**: Team member information and profiles.

**Data Structure**:
```
[
  {
    name: String (required)
    role: String (required)
    bio: String (required)
    email: String - Email or URL (required, validated)
  }
]
```

**Validation**: 
- Array type checking
- Per-member validation via `validateTeamMember()`
- Email/URL validation (allows both formats)
- Detailed error reporting with member identification

### Content Data Files (`data/*.yaml`)

**Files**:
- `home.yaml`: Hero, stats, announcements, recent events, mission, features, CTA
- `about.yaml`: Hero, mission/vision, approach, team section, values, CTA
- `events.yaml`: Upcoming events, past events, registration links
- `activities.yaml`: Core activities, upcoming activities, CTA
- `community.yaml`: Community description, join info, channels, testimonials
- `faq.yaml`: Frequently asked questions organized by category
- `contact.yaml`: Contact form info, methods, response times
- `global.yaml`: Navigation, footer, social links, common content

**Non-Technical User Access**: These files use YAML format for easy editing by non-technical users while maintaining program compatibility.

## Development Workflow

### Setup & Installation

```bash
# Install dependencies
npm install

# Configure execution policy (Windows)
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Development

```bash
# Start development server
npm start
# This will:
# - Start local server at http://localhost:8080
# - Enable live reload  
# - Watch CSS, design tokens, and data files
# - Listen on both watch:eleventy and watch:css

# Format code
npm run format

# Check formatting
npm run format:check

# Lint JavaScript
npm run lint
```

### Production Build

```bash
# Build for production
npm run build
# This will:
# - Clean _site directory
# - Build CSS with PostCSS
# - Generate static site with Eleventy
# - Output to _site/

# Clean build output
npm run clean
```

### Debugging

```bash
# Debug Eleventy
npm run debug
# Provides detailed debugging information
```

## Content Management

### For Non-Technical Users

Edit YAML files in the root `/data/` directory:
- Update text, headings, descriptions
- Modify links and URLs
- Add/remove list items (events, team, FAQs, etc.)
- No code knowledge required

See `ModificationGuide.md` for detailed instructions.

### For Technical Users

**Adding/Editing Pages**:
1. Create content in `src/content/*.md`
2. Add data to `data/*.yaml`
3. Update navigation in `src/data/site.js`
4. Create/modify components as needed

**Creating Components**:
1. New files in `src/components/`
2. Use Nunjucks syntax
3. Make reusable and configurable
4. Add CSS variables for theming

**Modifying the Page Shell**:
1. Update `src/components/base.njk` for global changes (head, SEO, header/footer)
2. Pages pull it in with `{% extends "base.njk" %}` + `{% block content %}` —
   Eleventy's `layout:` front matter is not used, because it crashes on Eleventy
   2.0.1 when combined with the `pagination` that builds the localized pages
3. Test in both light and dark themes, and on both `/…/` and `/it/…/`

**Adding Utilities**:
1. Use `src/utils/` for reusable functions
2. Add comprehensive JSDoc documentation
3. Include error handling
4. Validate all inputs

**Design System Changes**:
1. Modify YAML files in `src/design/`
2. Update corresponding CSS in `src/assets/css/style.css`
3. Test all pages and theme combinations
4. Rebuild with `npm run build`

## Design Token System

The website uses a comprehensive design token system that allows you to control all visual aspects through YAML files.

### Changing Colors

Edit `src/design/colors.yaml`:

```yaml
brand:
  primary: '#3b82f6' # Change primary brand color
  primaryDark: '#1e40af' # Darker variant
  secondary: '#10b981' # Secondary color
  accent: '#6d28d9' # Accent color
```

### Changing Themes

Edit `src/design/themes.yaml`:

```yaml
light:
  css:
    --bg-primary: '#ffffff' # Light mode background
    --text-primary: '#111827' # Light mode text
dark:
  css:
    --bg-primary: '#0f1727' # Dark mode background
    --text-primary: '#f9fafb' # Dark mode text
```

## Design Token System

The website uses a comprehensive design token system that allows you to control all visual aspects through YAML files without touching code.

### Changing Colors

Edit `src/design/colors.yaml`:

```yaml
brand:
  primary: '#3b82f6'        # Primary brand color
  primaryDark: '#1e40af'    # Darker variant
  secondary: '#10b981'      # Secondary color
  accent: '#6d28d9'         # Accent color
```

### Changing Themes

Edit `src/design/themes.yaml`:

```yaml
light:
  css:
    --bg-primary: '#ffffff'    # Light mode background
    --text-primary: '#111827'  # Light mode text
dark:
  css:
    --bg-primary: '#0f1727'    # Dark mode background
    --text-primary: '#f9fafb'  # Dark mode text
```

### Changing Typography

Edit `src/design/typography.yaml`:

```yaml
fontFamilies:
  sans:
    stack:
      - "'Inter'"
      - 'system-ui'
      - 'sans-serif'
```

### Changing Spacing

Edit `src/design/spacing.yaml`:

```yaml
padding:
  section:
    top: '4rem'     # Section top padding
    bottom: '4rem'  # Section bottom padding
```

### Changing Component Styles

Edit `src/design/components.yaml`:

```yaml
buttons:
  primary:
    background: 'linear-gradient(to right, var(--accent), var(--safety-blue))'
    padding:
      x: '1.5rem'
      y: '0.75rem'
```

## Theme System

- **Architecture**: CSS variables-based theme system with light/dark mode toggle
- **Default Theme**: Light mode
- **Theme Toggle**: Button in header (next to CTA button)
- **Persistence**: Theme preference saved in localStorage
- **Implementation**: 
  - CSS variables declared in `:root` for light theme (default)
  - `[data-theme='dark']` selector overrides variables for dark theme
  - A small inline script in `<head>` applies `data-theme` before first paint;
    the toggle handler lives in `src/assets/js/main.js`. Keep the bootstrap
    inline and in the head — moving it reintroduces a white flash on every visit
  - The toggle icon is chosen in CSS off `[data-theme]`, never assigned by JS
    (note: language is NOT client-side state — see "Bilingual pages" in README.md)
  - All colors, backgrounds, and theme-aware styles use CSS variables
- **Configuration**: Controlled via `src/design/themes.yaml` with 40+ CSS variables per theme
- **Coverage**: Uniformly applied across all pages and components
- **Text Readability**: Dark text on light, white/light text on dark (theme-aware)

## Code Quality & Best Practices

### General Guidelines

1. **Use Unified Validation**: Always use functions from `src/utils/validation.js` for validation
2. **Document New Functions**: Add JSDoc comments to all functions with @param, @returns, @example
3. **Error Handling**: All functions should validate inputs and handle errors gracefully
4. **CSS Variables**: Use only CSS variables (never hardcoded colors) in styles
5. **DRY Principle**: Avoid code duplication - extract reusable functions to `src/utils/`
6. **Type Safety**: Use JSDoc @type annotations for complex types
7. **Test Locally**: Always run `npm start` and test before committing

### JavaScript Standards

- Use `function` declarations or arrow functions consistently
- Add comprehensive JSDoc documentation
- Validate all function parameters
- Return structured objects: `{ valid: boolean, error/errors: ... }`
- Handle both browser and server environments
- Never use `console.error` without context
- Use descriptive variable and function names

### YAML/Data Standards

- Use 2-space indentation
- Keep data structures flat when possible
- Validate data on module load
- Provide default values for optional fields
- Use semantic naming for structure keys
- Document complex data structures in comments

### Component Standards (Nunjucks)

- Use semantic HTML elements
- Add ARIA labels for accessibility
- Make components reusable and parameterized
- Use CSS variables for all styling
- Test in both light and dark themes
- Include proper alt text for images
- Structure templates for maintainability

### Style Standards (CSS/Tailwind)

- Use Tailwind classes first (utility-first approach)
- Use CSS variables for theme-aware colors
- Keep specificity low
- Use calculated/relative sizing over absolute values
- Maintain responsive design (mobile-first)
- Test on multiple screen sizes
- Don't hardcode colors - use design tokens

## Best Practices for Modifications

1. **Use CSS Variables**: Always use CSS variables (e.g., `var(--text-primary)`, `var(--bg-primary)`) instead of hardcoded colors
2. **Update Design Tokens**: Modify values in `src/design/themes.yaml` for theme changes, not individual component styles
3. **Test Both Themes**: Always verify changes work in both light and dark mode (use theme toggle in header)
4. **Maintain Accessibility**: Ensure ARIA labels, semantic HTML, and sufficient color contrast in both themes
5. **Follow Code Style**: Maintain existing naming conventions and formatting with `npm run format`
6. **Responsive Design**: Test across all device sizes (mobile, tablet, desktop)
7. **Validate Data**: Handle errors gracefully in data files - use unified validation module
8. **Update Documentation**: Keep docs in sync with code changes
9. **Test Locally**: Always test before committing (`npm start`)
10. **CSS Variable Consistency**: When adding new styles, define corresponding variables in `themes.yaml`

## When Adding New Code

**For JavaScript files**:
```javascript
/**
 * Brief function description
 * @param {type} paramName - Parameter description
 * @returns {type} Return description
 * @throws {Error} Error conditions
 * @example
 * functionName(param); // Returns expected result
 */
function functionName(paramName) {
  // Validate input
  if (!paramName) {
    throw new Error('paramName is required');
  }
  
  // Implementation...
  
  return result;
}
```

**For new YAML files**:
```yaml
# File purpose and description
section1:
  field1: value        # Field description
  field2: value        # Field description
  
section2:
  # Sub-section description
  - id: 1
    title: "Item"      # Item description
    description: "..."
```

**For new Components**:
```nunjucks
{# Component description and usage #}
<div class="component" style="...">
  {{ variable | default('fallback') }}
</div>
```

## Common Tasks & Workflows

### Change Brand Colors

1. Edit `src/design/colors.yaml`
2. Update `brand.primary` and related colors
3. Rebuild: `npm run build`
4. Test in both light and dark mode

### Add a New Page

1. Create a new `.md` file in `src/content/`
2. Add corresponding YAML data in `data/`
3. Add navigation link in `src/data/site.js`
4. Create/update components as needed
5. Test theme toggle and responsive design

### Update Navigation

1. Modify `src/data/site.js` navigation array
2. Include name, url, and optional dropdown flag
3. Test links on local server
4. Rebuild and verify

### Change Fonts

1. Edit `src/design/typography.yaml`
2. Update `fontFamilies` section
3. Add fonts to `src/assets/fonts/` if needed
4. Rebuild: `npm run build`
5. Test heading and body text appearance

### Add Team Member

1. Update `src/data/team.js`
2. Include name, role, bio, email/URL
3. Run `npm start` to validate
4. Check team display on About page

### Modify Content (Non-Technical)

1. Open appropriate file in `data/` directory
2. Edit YAML values (text, URLs, lists)
3. Save file
4. Changes auto-reload in development server

### Change Spacing/Padding

1. Edit `src/design/spacing.yaml`
2. Update spacing values
3. Rebuild: `npm run build`
4. Test all pages for visual consistency

### Add a New Utility Function

1. Create in `src/utils/` or add to existing file
2. Add comprehensive JSDoc documentation
3. Include parameter validation
4. Handle errors gracefully
5. Export using CommonJS (`module.exports`)
6. Test in console before using

## Important Project Notes

- **Templating**: Uses Nunjucks engine (not Liquid or Handlebars)
- **Design System**: All visual properties defined in `src/design/` YAML files
- **CSS Architecture**: Combination of Tailwind utility classes and custom CSS with variables
- **Data Validation**: Integrated in data files using unified validation module
- **Responsive Design**: Mobile-first approach with Tailwind breakpoints
- **Accessibility**: Skip links, ARIA labels, semantic HTML, keyboard navigation
- **Content Separation**: Code and design separated from content for non-technical editing
- **Theme System**: CSS variables with localStorage persistence
- **No Hardcoded Colors**: All colors use design tokens and CSS variables
- **Performance**: Static site generation ensures fast load times

## Code Organization Principles

### Single Responsibility
- Each module/function has one clear purpose
- Files are organized by function type (utils, data, components, layouts)
- Keep files focused and not too large (< 300 lines recommended)

### Modularity  
- Reusable functions in `src/utils/`
- Reusable components in `src/components/`
- Clear separation between presentation and data
- Loose coupling via configuration and parameters

### Maintainability
- Clear naming conventions throughout
- Comprehensive documentation
- Consistent code style (enforced by Prettier/ESLint)
- Data validation at entry points
- Error handling with meaningful messages

### Scalability
- Easy to add new pages without duplicating code
- Component-based architecture allows reuse
- Design token system accommodates new customizations
- Data files remain manageable size
- Simple to extend functionality

## Quality Assurance Checklist

Before committing code:
- [ ] `npm run format:check` passes
- [ ] `npm run lint` passes with no errors
- [ ] `npm start` runs without errors
- [ ] No console errors in browser
- [ ] Tested in light theme
- [ ] Tested in dark theme
- [ ] Works on mobile (use browser dev tools)
- [ ] Works on tablet
- [ ] Works on desktop
- [ ] All links are functional
- [ ] No hardcoded colors in new CSS
- [ ] New functions have JSDoc comments
- [ ] Data files validate on load
- [ ] No dead code or console.log statements
- [ ] Documentation updated if needed

## Quick Reference: Key Commands

```bash
npm install          # Install all dependencies
npm start            # Start dev server with auto-reload
npm run build        # Build for production
npm run clean        # Remove build output
npm run format       # Format all files with Prettier
npm run format:check # Check formatting without changes
npm run lint         # Lint JavaScript with ESLint
npm run debug        # Debug Eleventy with verbose output
```

## Dependencies Overview

**Build & Development**:
- `@11ty/eleventy`: Static site generator
- `tailwindcss`: Utility-first CSS framework
- `postcss`: CSS processing
- `autoprefixer`: Browser prefix support

**Code Quality**:
- `eslint`: JavaScript linting
- `prettier`: Code formatting
- `husky`: Git hooks
- `lint-staged`: Pre-commit linting

**Processing**:
- `js-yaml`: YAML parsing
- `ajv`: JSON Schema validation (for content validation)
- `npm-run-all`: Concurrent command execution
- `rimraf`: Cross-platform file deletion

## Testing Checklist

- [ ] Design changes reflect across all pages
- [ ] Light theme displays correctly with proper contrast
- [ ] Dark theme displays correctly with proper contrast
- [ ] Theme toggle persists selection across page reload
- [ ] All text remains readable in both themes
- [ ] Color gradients appear correct in both themes
- [ ] Card backgrounds, borders, shadows display properly in both themes  
- [ ] Hero banner has correct transparency and text colors
- [ ] Responsive design works on mobile, tablet, desktop
- [ ] All links and interactive elements function
- [ ] Build completes without errors
- [ ] CSS variables used instead of hardcoded colors
- [ ] No validation errors on data files
- [ ] No console warnings or errors

----

**Document Version**: 2.0 (Refactored)  
**Last Updated**: February 2026  
**Maintainer**: AI Safety Italia Development Team

