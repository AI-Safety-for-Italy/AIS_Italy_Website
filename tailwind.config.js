const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");

// Load design tokens from YAML files
const designDir = path.join(__dirname, 'src', 'design');
const loadDesignFile = (filename) => {
  try {
    const filePath = path.join(designDir, filename);
    if (fs.existsSync(filePath)) {
      const fileContents = fs.readFileSync(filePath, 'utf8');
      return yaml.load(fileContents);
    }
  } catch (error) {
    console.error(`Error loading design file ${filename}:`, error);
  }
  return {};
};

// Load design tokens
const colors = loadDesignFile('colors.yaml');
const typography = loadDesignFile('typography.yaml');
const spacing = loadDesignFile('spacing.yaml');
const layout = loadDesignFile('layout.yaml');

// Build Tailwind color palette from design tokens
const buildColorPalette = (colorObj) => {
  if (!colorObj) return {};
  const palette = {};
  Object.entries(colorObj).forEach(([key, value]) => {
    if (typeof value === 'string') {
      palette[key] = value;
    }
  });
  return palette;
};

module.exports = {
  content: ["src/**/*.{html,md,njk}"],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: buildColorPalette(colors.brand),
        semantic: buildColorPalette(colors.semantic),
        accent: colors.brand?.primary || '#008C45',
        'accent-emerald': colors.custom?.['accent-emerald'] || '#2FBF71',
        'accent-dark': colors.brand?.primaryDark || '#006F38',
        'safety-green': colors.custom?.['safety-green'] || '#008C45',
        'safety-red': colors.custom?.['safety-red'] || '#CD212A',
        danger: colors.semantic?.error || '#CD212A',
        success: colors.semantic?.success || '#16a34a',
        warning: colors.semantic?.warning || '#f59e0b',
        info: colors.semantic?.info || '#008C45',
        primary: buildColorPalette(colors.neutral),
        bg: {
          light: buildColorPalette(colors.background?.light),
          dark: buildColorPalette(colors.background?.dark),
        },
        text: {
          light: buildColorPalette(colors.text?.light),
          dark: buildColorPalette(colors.text?.dark),
        },
        border: {
          light: buildColorPalette(colors.border?.light),
          dark: buildColorPalette(colors.border?.dark),
        },
      },
      fontFamily: {
        sans: typography.fontFamilies?.sans?.stack || ['system-ui', '-apple-system', 'sans-serif'],
        display: typography.fontFamilies?.display?.stack || ['system-ui', '-apple-system', 'sans-serif'],
        mono: typography.fontFamilies?.mono?.stack || ['ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        xs: [typography.fontSizes?.xs?.value || '0.75rem', typography.fontSizes?.xs?.lineHeight || '1.5'],
        sm: [typography.fontSizes?.sm?.value || '0.875rem', typography.fontSizes?.sm?.lineHeight || '1.5'],
        base: [typography.fontSizes?.base?.value || '1rem', typography.fontSizes?.base?.lineHeight || '1.6'],
        lg: [typography.fontSizes?.lg?.value || '1.125rem', typography.fontSizes?.lg?.lineHeight || '1.6'],
        xl: [typography.fontSizes?.xl?.value || '1.25rem', typography.fontSizes?.xl?.lineHeight || '1.6'],
        '2xl': [typography.fontSizes?.['2xl']?.value || '1.5rem', typography.fontSizes?.['2xl']?.lineHeight || '1.4'],
        '3xl': [typography.fontSizes?.['3xl']?.value || '1.875rem', typography.fontSizes?.['3xl']?.lineHeight || '1.3'],
        '4xl': [typography.fontSizes?.['4xl']?.value || '2.25rem', typography.fontSizes?.['4xl']?.lineHeight || '1.2'],
        '5xl': [typography.fontSizes?.['5xl']?.value || '3rem', typography.fontSizes?.['5xl']?.lineHeight || '1.1'],
        '6xl': [typography.fontSizes?.['6xl']?.value || '3.75rem', typography.fontSizes?.['6xl']?.lineHeight || '1.1'],
        '7xl': [typography.fontSizes?.['7xl']?.value || '4.5rem', typography.fontSizes?.['7xl']?.lineHeight || '1.1'],
      },
      fontWeight: {
        thin: typography.fontWeights?.thin || 100,
        extralight: typography.fontWeights?.extralight || 200,
        light: typography.fontWeights?.light || 300,
        normal: typography.fontWeights?.normal || 400,
        medium: typography.fontWeights?.medium || 500,
        semibold: typography.fontWeights?.semibold || 600,
        bold: typography.fontWeights?.bold || 700,
        extrabold: typography.fontWeights?.extrabold || 800,
        black: typography.fontWeights?.black || 900,
      },
      spacing: {
        ...buildColorPalette(spacing.base),
      },
      letterSpacing: {
        tighter: typography.letterSpacing?.tighter || '-0.05em',
        tight: typography.letterSpacing?.tight || '-0.025em',
        normal: typography.letterSpacing?.normal || '0',
        wide: typography.letterSpacing?.wide || '0.025em',
        wider: typography.letterSpacing?.wider || '0.05em',
        widest: typography.letterSpacing?.widest || '0.1em',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
        'gradient-primary': 'linear-gradient(to right, #008C45, #005C2E)',
        'gradient-accent': 'linear-gradient(to right, #008C45, #CD212A)',
      },
      animation: {
        'fade-in': 'fadeIn 0.6s ease-in',
        'slide-up': 'slideUp 0.6s ease-out',
        'pulse-glow': 'pulseGlow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseGlow: {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 20px rgba(0, 140, 69, 0.5)' },
          '50%': { opacity: '0.8', boxShadow: '0 0 30px rgba(0, 140, 69, 0.8)' },
        },
      },
      borderRadius: {
        none: '0',
        sm: '0.25rem',
        default: '0.375rem',
        md: '0.5rem',
        lg: '0.75rem',
        xl: '1rem',
        '2xl': '1.5rem',
        full: '9999px',
      },
      boxShadow: {
        sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
        default: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
        md: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
        lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
        xl: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
      },
      container: {
        center: true,
        padding: {
          default: '1rem',
          md: '1.5rem',
          lg: '2rem',
        },
        screens: {
          sm: '640px',
          md: '768px',
          lg: '1024px',
          xl: '1280px',
          '2xl': '1536px',
        },
      },
      zIndex: {
        hidden: '-1',
        base: '0',
        dropdown: '100',
        sticky: '50',
        fixed: '100',
        modal: '200',
        popover: '300',
        tooltip: '400',
        notification: '500',
      },
    }
  },
  plugins: []
}
