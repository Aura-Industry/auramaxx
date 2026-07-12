/**
 * Theme system types, defaults, and utilities
 */

// ============================================================================
// TYPES
// ============================================================================

export interface ThemeColors {
  mode: 'light' | 'dark';

  // Accent (primary brand)
  accent: string;
  accentForeground: string;

  // Semantic
  warning: string;
  warningForeground: string;
  danger: string;
  dangerForeground: string;
  success: string;
  successForeground: string;
  info: string;
  infoForeground: string;

  // Backgrounds
  background: string;
  backgroundAlt: string;
  surface: string;
  surfaceAlt: string;

  // Text
  text: string;
  textMuted: string;
  textFaint: string;

  // Borders
  border: string;
  borderMuted: string;
  borderFocus: string;

  // Scrollbar
  scrollbarTrack: string;
  scrollbarThumb: string;
  scrollbarThumbHover: string;
}

export interface AppPaletteColor {
  band: string;
  accent: string;
  bg: string;
  text: string;
}

export interface Theme {
  id: string;
  name: string;
  colors: ThemeColors;
  appPalette: Record<string, AppPaletteColor>;
}

export interface WorkspaceThemeOverride {
  accent?: string;
  mode?: 'light' | 'dark';
  appPalette?: Partial<Record<string, AppPaletteColor>>;
}

// ============================================================================
// DEFAULT APP PALETTES
// ============================================================================

const LIGHT_APP_PALETTE: Record<string, AppPaletteColor> = {
  blue: {
    band: '#0047ff',
    accent: 'rgba(0, 71, 255, 0.3)',
    bg: 'rgba(0, 71, 255, 0.05)',
    text: '#0047ff',
  },
  orange: {
    band: '#ff4d00',
    accent: 'rgba(255, 77, 0, 0.3)',
    bg: 'rgba(255, 77, 0, 0.05)',
    text: '#ff4d00',
  },
  lime: {
    band: '#84cc16',
    accent: 'rgba(132, 204, 22, 0.3)',
    bg: 'rgba(132, 204, 22, 0.05)',
    text: '#65a30d',
  },
  purple: {
    band: '#7c3aed',
    accent: 'rgba(124, 58, 237, 0.3)',
    bg: 'rgba(124, 58, 237, 0.05)',
    text: '#7c3aed',
  },
  gray: {
    band: '#6b7280',
    accent: 'rgba(107, 114, 128, 0.3)',
    bg: 'rgba(107, 114, 128, 0.05)',
    text: '#6b7280',
  },
  teal: {
    band: '#14b8a6',
    accent: 'rgba(20, 184, 166, 0.3)',
    bg: 'rgba(20, 184, 166, 0.05)',
    text: '#14b8a6',
  },
  rose: {
    band: '#f43f5e',
    accent: 'rgba(244, 63, 94, 0.3)',
    bg: 'rgba(244, 63, 94, 0.05)',
    text: '#f43f5e',
  },
};

const DARK_APP_PALETTE: Record<string, AppPaletteColor> = {
  blue: {
    band: '#0047ff',
    accent: 'rgba(0, 71, 255, 0.4)',
    bg: 'rgba(0, 71, 255, 0.1)',
    text: '#5c8aff',
  },
  orange: {
    band: '#ff4d00',
    accent: 'rgba(255, 77, 0, 0.4)',
    bg: 'rgba(255, 77, 0, 0.1)',
    text: '#ff7a40',
  },
  lime: {
    band: '#84cc16',
    accent: 'rgba(132, 204, 22, 0.4)',
    bg: 'rgba(132, 204, 22, 0.1)',
    text: '#a3e635',
  },
  purple: {
    band: '#7c3aed',
    accent: 'rgba(124, 58, 237, 0.4)',
    bg: 'rgba(124, 58, 237, 0.1)',
    text: '#a78bfa',
  },
  gray: {
    band: '#6b7280',
    accent: 'rgba(107, 114, 128, 0.4)',
    bg: 'rgba(107, 114, 128, 0.1)',
    text: '#9ca3af',
  },
  teal: {
    band: '#14b8a6',
    accent: 'rgba(20, 184, 166, 0.4)',
    bg: 'rgba(20, 184, 166, 0.1)',
    text: '#2dd4bf',
  },
  rose: {
    band: '#f43f5e',
    accent: 'rgba(244, 63, 94, 0.4)',
    bg: 'rgba(244, 63, 94, 0.1)',
    text: '#fb7185',
  },
};

// ============================================================================
// DEFAULT THEMES
// ============================================================================

export const DEFAULT_LIGHT_THEME: Theme = {
  id: 'light',
  name: 'Light',
  colors: {
    mode: 'light',

    // Accent
    accent: '#ccff00',
    accentForeground: '#0a0a0a',

    // Semantic
    warning: '#ff4d00',
    warningForeground: '#ffffff',
    danger: '#ef4444',
    dangerForeground: '#ffffff',
    success: '#00c853',
    successForeground: '#ffffff',
    info: '#0047ff',
    infoForeground: '#ffffff',

    // Backgrounds
    background: '#f5f5f5',
    backgroundAlt: '#e8e8e6',
    surface: '#ffffff',
    surfaceAlt: '#fafafa',

    // Text
    text: '#0a0a0a',
    textMuted: '#6b7280',
    textFaint: '#9ca3af',

    // Borders
    border: '#d4d4d8',
    borderMuted: '#e5e5e5',
    borderFocus: '#0a0a0a',

    // Scrollbar
    scrollbarTrack: '#f5f5f5',
    scrollbarThumb: '#d4d4d8',
    scrollbarThumbHover: '#0a0a0a',
  },
  appPalette: LIGHT_APP_PALETTE,
};

export const DEFAULT_DARK_THEME: Theme = {
  id: 'dark',
  name: 'Dark',
  colors: {
    mode: 'dark',

    // Accent
    accent: '#ccff00',
    accentForeground: '#0a0a0a',

    // Semantic
    warning: '#ff4d00',
    warningForeground: '#ffffff',
    danger: '#ef4444',
    dangerForeground: '#ffffff',
    success: '#00c853',
    successForeground: '#ffffff',
    info: '#0047ff',
    infoForeground: '#ffffff',

    // Backgrounds
    background: '#0a0a0a',
    backgroundAlt: '#141414',
    surface: '#1a1a1a',
    surfaceAlt: '#242424',

    // Text
    text: '#ffffff',
    textMuted: '#a1a1aa',
    textFaint: '#71717a',

    // Borders
    border: '#27272a',
    borderMuted: '#3f3f46',
    borderFocus: '#ccff00',

    // Scrollbar
    scrollbarTrack: '#0a0a0a',
    scrollbarThumb: '#3f3f46',
    scrollbarThumbHover: '#ccff00',
  },
  appPalette: DARK_APP_PALETTE,
};

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Merge a partial theme override into a base theme
 */
export function mergeThemes(base: Theme, override: Partial<Theme>): Theme {
  return {
    ...base,
    ...override,
    colors: {
      ...base.colors,
      ...override.colors,
    },
    appPalette: {
      ...base.appPalette,
      ...override.appPalette,
    },
  };
}

/**
 * Get theme by ID
 */
export function getThemeById(id: string): Theme {
  return id === 'dark' ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
}

/**
 * Apply theme colors to CSS custom properties
 */
export function applyThemeToCSSVariables(theme: Theme): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  // Set data-theme attribute for CSS selector
  root.setAttribute('data-theme', theme.colors.mode);

  // Apply color variables
  root.style.setProperty('--theme-mode', theme.colors.mode);

  // Accent
  root.style.setProperty('--color-accent', theme.colors.accent);
  root.style.setProperty('--color-accent-foreground', theme.colors.accentForeground);

  // Semantic
  root.style.setProperty('--color-warning', theme.colors.warning);
  root.style.setProperty('--color-warning-foreground', theme.colors.warningForeground);
  root.style.setProperty('--color-danger', theme.colors.danger);
  root.style.setProperty('--color-danger-foreground', theme.colors.dangerForeground);
  root.style.setProperty('--color-success', theme.colors.success);
  root.style.setProperty('--color-success-foreground', theme.colors.successForeground);
  root.style.setProperty('--color-info', theme.colors.info);
  root.style.setProperty('--color-info-foreground', theme.colors.infoForeground);

  // Backgrounds
  root.style.setProperty('--color-background', theme.colors.background);
  root.style.setProperty('--color-background-alt', theme.colors.backgroundAlt);
  root.style.setProperty('--color-surface', theme.colors.surface);
  root.style.setProperty('--color-surface-alt', theme.colors.surfaceAlt);

  // Text
  root.style.setProperty('--color-text', theme.colors.text);
  root.style.setProperty('--color-text-muted', theme.colors.textMuted);
  root.style.setProperty('--color-text-faint', theme.colors.textFaint);

  // Borders
  root.style.setProperty('--color-border', theme.colors.border);
  root.style.setProperty('--color-border-muted', theme.colors.borderMuted);
  root.style.setProperty('--color-border-focus', theme.colors.borderFocus);

  // Scrollbar
  root.style.setProperty('--color-scrollbar-track', theme.colors.scrollbarTrack);
  root.style.setProperty('--color-scrollbar-thumb', theme.colors.scrollbarThumb);
  root.style.setProperty('--color-scrollbar-thumb-hover', theme.colors.scrollbarThumbHover);

  // App palette
  Object.entries(theme.appPalette).forEach(([colorName, palette]) => {
    root.style.setProperty(`--app-${colorName}-band`, palette.band);
    root.style.setProperty(`--app-${colorName}-accent`, palette.accent);
    root.style.setProperty(`--app-${colorName}-bg`, palette.bg);
    root.style.setProperty(`--app-${colorName}-text`, palette.text);
  });
}

/**
 * Create a theme with a custom accent color
 */
export function createThemeWithAccent(baseTheme: Theme, accent: string): Theme {
  return mergeThemes(baseTheme, {
    colors: {
      ...baseTheme.colors,
      accent,
    },
  });
}
