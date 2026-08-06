# Content & Design Modification Guide for AIS Italy Website

## Introduction

Welcome to the AIS Italy Website Modification Guide! This document is designed to help users edit website content and design safely and effectively without affecting the underlying functionality.

The website has been restructured with a **design token system** that separates content, design, and code. This means you can update both content AND visual design without touching any code!

## Two Types of Modifications

### 1. Content Changes (Non-Technical)

For updating text, headings, images, and page content - use the `/data` directory.

### 2. Design Changes (Non-Technical)

For updating colors, fonts, spacing, and visual styles - use the `/src/design` directory.

## Part 1: Content Modifications

### The Data Directory

All content lives in the `/data` directory at the root of the project:

- `home.yaml` - Homepage content
- `about.yaml` - About Us page content
- `events.yaml` - Events & News page content
- `activities.yaml` - Activities page content
- `community.yaml` - Community page content
- `faq.yaml` - FAQ page content
- `contact.yaml` - Contact page content
- `global.yaml` - Shared content (navigation, footer, social links)

### File Format

We use YAML format - it's human-readable and uses simple indentation.

### Common Content Tasks

#### Updating Homepage Text

1. Open `data/home.yaml`
2. Find the section (e.g., `hero:`, `mission:`, `features:`)
3. Update the text after colons
4. Save the file

#### Adding a New Event

1. Open `data/events.yaml`
2. Find `upcoming_events:` section
3. Add a new item following the existing structure
4. Increment the `id` number
5. Save the file

#### Changing Navigation Links

1. Open `data/global.yaml`
2. Find `navigation:` section
3. Update `name` or `url` fields
4. Save the file

#### Modifying FAQ Questions

1. Open `data/faq.yaml`
2. Find `categories:` section
3. Locate the question and update `question` or `answer`
4. Save the file

## Understanding the Theme System

The website uses a **CSS variable-based theme system** that provides seamless switching between light and dark modes. Every color, background, and styled element uses CSS variables that automatically change when the theme is toggled.

### How It Works

1. **Light Theme (Default)**: Website loads with light theme using CSS variables
2. **Dark Theme**: When user clicks theme toggle button, variables are overridden for dark mode
3. **Automatic Switching**: All colors automatically adjust - no manual work needed
4. **Persistence**: User's choice is saved, so light/dark preference persists on reload

### Theme Variables Location

All theme colors are defined in: **`src/design/themes.yaml`**

This file contains 40+ CSS variables for each theme (light and dark), controlling:

- Background colors
- Text colors
- Card styling
- Borders and shadows
- Accent colors
- Gradients
- And more

### Changing Brand Colors

**File**: `src/design/colors.yaml`

```yaml
# Change these values to update brand colors
brand:
  primary: '#3b82f6' # Main brand color (blue)
  primaryDark: '#1e40af' # Darker variant
  secondary: '#10b981' # Secondary color (emerald)
  accent: '#6d28d9' # Accent color (purple)
```

**What changes**: Buttons, links, accents, gradients across the entire site

### Changing Theme Colors (Light & Dark)

**File**: `src/design/themes.yaml`

This file controls the appearance of both light and dark themes. Each theme has 40+ CSS variables.

**Light Theme Section:**

```yaml
light:
  css:
    --bg-primary: '#ffffff'           # Main background (light)
    --bg-secondary: '#f8fafc'         # Secondary background
    --text-primary: '#0f1727'         # Main text (dark)
    --text-secondary: '#334155'       # Secondary text
    --text-tertiary: '#94a3b8'        # Tertiary text
    --accent: '#0369a1'               # Primary blue
    --card-bg: '#ffffff'              # Card background
    --card-hover: '#f1f5f9'           # Card hover state
    --card-border: '#e2e8f0'          # Card border color
    # ... more variables ...
```

**Dark Theme Section:**

```yaml
dark:
  css:
    --bg-primary: '#0f172a'           # Main background (dark)
    --bg-secondary: '#1e293b'         # Secondary background
    --text-primary: '#f8fafc'         # Main text (light)
    --text-secondary: '#cbd5e1'       # Secondary text
    --text-tertiary: '#94a3b8'        # Tertiary text
    --accent: '#38bdf8'               # Primary blue (lighter)
    --card-bg: '#1e293b'              # Card background
    --card-hover: '#334155'           # Card hover state
    --card-border: '#334155'          # Card border color
    # ... more variables ...
```

**Key Variables:**

- `--bg-primary` / `--bg-secondary` / `--bg-tertiary` - Page backgrounds
- `--text-primary` / `--text-secondary` / `--text-tertiary` - Text colors
- `--accent` - Primary brand color
- `--card-bg`, `--card-border`, `--card-shadow` - Card styling
- `--success`, `--warning`, `--error`, `--info` - Semantic colors

**What Changes**: Everything! All colors automatically adjust when the theme is switched.

**To Modify**:

1. Open `src/design/themes.yaml`
2. Find the `light:` section for light mode, or `dark:` section for dark mode
3. Locate the variable you want to change (e.g., `--accent`)
4. Update the hex color value (e.g., `'#0369a1'` to `'#3b82f6'`)
5. Save and reload the website
6. Use the theme toggle button in the header to verify changes in both modes

#### Changing Fonts

**File**: `src/design/typography.yaml`

```yaml
fontFamilies:
  sans:
    stack:
      - "'Inter'" # Your chosen font
      - 'system-ui'
      - 'sans-serif'
  display:
    stack:
      - "'Poppins'" # Heading font
      - 'system-ui'
      - 'sans-serif'
```

**What Changes**: Font across the website. Your choice applies to both light and dark themes.

#### Changing Font Sizes

**File**: `src/design/typography.yaml`

```yaml
fontSizes:
  h1:
    value: '2.5rem' # Heading 1 size
    weight: 700 # Boldness
  body:
    value: '1rem' # Body text size
```

**What Changes**: All text sizes. Your changes apply to both themes.

#### Changing Spacing & Padding

**File**: `src/design/spacing.yaml`

```yaml
padding:
  section:
    top: '4rem'      # Top padding for sections
    bottom: '4rem'   # Bottom padding for sections
  card:
    default: '1.5rem'  # Card padding
```

**What Changes**: Spacing between sections, inside cards, and padding throughout the site. Changes apply to both themes.

#### Changing Button Styles

**File**: `src/design/components.yaml`

```yaml
buttons:
  primary:
    background: 'linear-gradient(to right, var(--accent), var(--safety-blue))'
    padding:
      x: '1.5rem' # Horizontal padding
      y: '0.75rem' # Vertical padding
```

**What Changes**: All primary buttons. Uses theme CSS variables, so automatically works in both light and dark modes.

## Step-by-Step Editing Instructions

### 1. Find the Right File

- **Content change**: Go to `/data` directory
- **Design change**: Go to `/src/design` directory
- Open the corresponding YAML file

### 2. Make Your Changes

- Locate the section you want to edit
- Modify values after colons
- Maintain proper indentation (use spaces, not tabs)

### 3. Edit Lists

Lists use hyphens (-):

```yaml
features:
  - id: 1
    emoji: '🎓'
    title: 'Educational Programs'
    description: 'Your description here'
```

### 4. Add New Items

```yaml
features:
  - id: 1
    emoji: '🎓'
    title: 'First Item'
  - id: 2 # New item
    emoji: '🤝'
    title: 'Second Item'
```

### 5. Save and Test

- Save the file
- Run `npm start` to preview locally
- Check that changes appear correctly

## YAML Formatting Rules

### Do's ✅

```yaml
# Use spaces for indentation (2 spaces)
section:
  title: 'My Title'
  items:
    - item 1
    - item 2

# Use quotes for special characters
description: 'This has a colon: in it'
# Comments start with #
```

### Don'ts ❌

```yaml
# Don't use tabs
section:
	title: "Wrong"  # Tab character

# Don't forget space after colon
title:"Missing space"  # Wrong

# Don't forget quotes for special chars
url: https://example.com  # Might break
```

## Safe Characters

**Safe to use without quotes**: Letters, numbers, spaces, basic punctuation

**Need quotes**: `:`, `-`, `#`, `{`, `}`, `[`, `]`, `|`, `>`, `%`, `@`, `*`, `&`, `!`, `<`, `=`, `'`, `"`

Example:

```yaml
# Safe
title: Hello World

# Needs quotes
description: 'Contains: colon & special chars!'
```

## Testing Your Changes

### Before Publishing

1. **Preview locally**: Run `npm start` and visit `http://localhost:8080`
2. **Check affected pages**: Navigate to pages you modified
3. **Verify design**: Ensure colors, fonts, spacing look correct
4. **Test both themes**: Click the theme toggle button in the header to verify **light AND dark modes**
5. **Check text contrast**: Ensure text is readable in both modes
6. **Test links**: Click all links to verify functionality
7. **Check mobile**: View on different screen sizes (use F12 → Device Emulation)

### Key Testing Points for Theme Changes

- [ ] Background colors are correct in light mode
- [ ] Background colors are correct in dark mode
- [ ] Text colors have sufficient contrast in light mode
- [ ] Text colors have sufficient contrast in dark mode
- [ ] Card backgrounds and borders display properly in both modes
- [ ] Buttons have proper colors and visibility in both modes
- [ ] Shadows display correctly in both modes (may be more subtle in dark)
- [ ] All pages maintain proper styling in both themes

### Troubleshooting

**Site doesn't load after changes:**

1. Check console for error messages (F12 → Console tab)
2. Verify YAML syntax (indentation, colons, quotes)
3. Compare with previous working version

**Content doesn't appear:**

1. Verify field name matches template
2. Check file is in correct location
3. Ensure site rebuilt after changes
4. Clear browser cache

**Design doesn't update:**

1. Clear browser cache (Ctrl+Shift+Delete)
2. Rebuild: `npm run build`
3. Check YAML syntax in design file

**Colors look wrong:**

1. Verify hex color format (e.g., `#3b82f6`)
2. Check CSS variable references in themes.yaml
3. **Test in both light and dark modes** using theme toggle button

**Theme Toggle Doesn't Work:**

1. Check that `data-theme` attribute is on `<html>` element (in browser DevTools)
2. Clear localStorage (F12 → Application → Local Storage → Clear All)
3. Refresh page

**Dark Mode Not Showing:**

1. Verify dark theme variables are in `src/design/themes.yaml` under the `dark:` section
2. Check that `[data-theme='dark']` CSS rules are present in styles
3. Use browser DevTools (F12) to inspect: right-click element → Inspect
4. Verify CSS variables are being applied

## Warnings: Files Not to Edit

⚠️ **DO NOT EDIT THESE FILES** unless you know what you're doing:

- `/src/assets/css/style.css` - CSS file (use `src/design/` for styling changes instead)
- `/src/components/base.njk` - Page shell (head, SEO, JSON-LD, header/footer)
- `/src/data/locales.js` - Locale definitions driving the /it/ pages
- `/src/components/` - Reusable component templates
- `/src/utils/` - Utility logic
- `.eleventy.js` - Site configuration
- `package.json` - Dependencies
- `tailwind.config.js` - Styling configuration

Editing these files could break the website functionality or break the theme system.

**Theme colors should ALWAYS be updated in**:
- `src/design/themes.yaml` (CSS variables for light/dark modes) ✅
- **NOT** in `src/assets/css/style.css` ❌

## Quick Reference

### Change Theme Colors (Most Common Change)

**File**: `src/design/themes.yaml`

Find the `light:` section for light mode colors, or `dark:` section for dark mode colors. Update hex values in the `css:` subsection.

```yaml
light:
  css:
    --bg-primary: '#ffffff'  # Change this
    --text-primary: '#0f1727'  # Or this
    # etc.
dark:
  css:
    --bg-primary: '#0f172a'  # Dark mode versions
    --text-primary: '#f8fafc'
    # etc.
```

### Change Brand Colors

**File**: `src/design/colors.yaml` (reference) and `src/design/themes.yaml` (active)

Primary brand color is stored in themes.yaml as `--accent` for both light and dark modes.

### Change Fonts

**File**: `src/design/typography.yaml`

```yaml
fontFamilies:
  sans:
    stack: ["'Your Font'", 'sans-serif']
```

### Change Spacing

**File**: `src/design/spacing.yaml`

```yaml
padding:
  section:
    top: '6rem'
```

### Update Homepage

**File**: `data/home.yaml`

- Edit hero, features, mission sections

### Update Navigation

**File**: `data/global.yaml`

- Edit navigation section

### Add Event

**File**: `data/events.yaml`

- Add to upcoming_events list

### Test Your Changes

1. Save the file
2. Run `npm start` to view locally (`http://localhost:8080`)
3. **Test both themes** - use the theme toggle button in the header to verify light and dark modes
4. Check mobile responsiveness
5. Verify all pages affected by your changes

## Support

If you encounter issues:

- Contact the technical team
- Check `src/design/README.md` for design system docs
- Refer to original developers

**Remember**: The system is designed to be safe. Content and design files include validation and fallbacks to prevent breaking the site!
