'use client';

import {
  createElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ColorMode = 'light' | 'dark';
export type UiScale = 'normal' | 'big';
export type AuraTheme = 'default' | 'dark' | 'big';

const LEGACY_THEME_STORAGE_KEY = 'aura-theme';
const THEME_PREFS_STORAGE_KEY = 'agent-theme-preferences';
const DEFAULT_THEME_PREFS: { colorMode: ColorMode; uiScale: UiScale } = {
  colorMode: 'light',
  uiScale: 'normal',
};

interface ThemeContextValue {
  colorMode: ColorMode;
  uiScale: UiScale;
  setColorMode: (mode: ColorMode) => void;
  setUiScale: (scale: UiScale) => void;
  // Back-compat shim for existing callers/tests
  theme: AuraTheme;
  setTheme: (theme: AuraTheme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function normalizeTheme(theme: AuraTheme): { colorMode: ColorMode; uiScale: UiScale } {
  if (theme === 'dark') return { colorMode: 'dark', uiScale: 'normal' };
  if (theme === 'big') return { colorMode: 'light', uiScale: 'big' };
  return { colorMode: 'light', uiScale: 'normal' };
}

function toLegacyTheme(colorMode: ColorMode, uiScale: UiScale): AuraTheme {
  if (uiScale === 'big') return 'big';
  return colorMode === 'dark' ? 'dark' : 'default';
}

function readStoredPrefs(): { colorMode: ColorMode; uiScale: UiScale } {
  if (typeof window === 'undefined') return DEFAULT_THEME_PREFS;

  try {
    const rawPrefs = window.localStorage.getItem(THEME_PREFS_STORAGE_KEY);
    if (rawPrefs) {
      const parsed = JSON.parse(rawPrefs) as { colorMode?: string; uiScale?: string };
      const colorMode: ColorMode = parsed.colorMode === 'dark' ? 'dark' : 'light';
      const uiScale: UiScale = parsed.uiScale === 'big' ? 'big' : 'normal';
      return { colorMode, uiScale };
    }
  } catch {
    // ignore malformed local state
  }

  const legacyTheme = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY) as AuraTheme | null;
  return normalizeTheme(legacyTheme === 'dark' || legacyTheme === 'big' ? legacyTheme : 'default');
}

function applyThemeAttributes(colorMode: ColorMode, uiScale: UiScale): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  if (colorMode === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');

  root.setAttribute('data-ui-scale', uiScale);

  const scale = uiScale === 'big' ? 1.25 : 1;
  root.style.setProperty('--ui-scale-factor', String(scale));

  root.style.setProperty('--font-size-xs', `${Math.round(10 * scale)}px`);
  root.style.setProperty('--font-size-sm', `${Math.round(12 * scale)}px`);
  root.style.setProperty('--font-size-md', `${Math.round(14 * scale)}px`);
  root.style.setProperty('--font-size-lg', `${Math.round(18 * scale)}px`);

  root.style.setProperty('--space-1', `${Math.round(4 * scale)}px`);
  root.style.setProperty('--space-2', `${Math.round(8 * scale)}px`);
  root.style.setProperty('--space-3', `${Math.round(12 * scale)}px`);
  root.style.setProperty('--space-4', `${Math.round(16 * scale)}px`);
  root.style.setProperty('--space-6', `${Math.round(24 * scale)}px`);

  root.style.setProperty('--radius-sm', `${Math.round(6 * scale)}px`);
  root.style.setProperty('--radius-md', `${Math.round(10 * scale)}px`);
  root.style.setProperty('--radius-lg', `${Math.round(14 * scale)}px`);
  root.style.setProperty('--shadow-sm', uiScale === 'big' ? '0 2px 4px rgba(0,0,0,0.15)' : '0 1px 2px rgba(0,0,0,0.12)');
  root.style.setProperty('--shadow-md', uiScale === 'big' ? '0 8px 20px rgba(0,0,0,0.24)' : '0 6px 16px rgba(0,0,0,0.18)');

  root.style.setProperty('--control-height-sm', `${Math.round(32 * scale)}px`);
  root.style.setProperty('--control-height-md', `${Math.round(36 * scale)}px`);
  root.style.setProperty('--control-height-lg', `${Math.round(40 * scale)}px`);

  // keep existing aliases used around the codebase
  root.style.setProperty('--space-xs', `var(--space-1)`);
  root.style.setProperty('--space-sm', `var(--space-2)`);
  root.style.setProperty('--space-md', `var(--space-3)`);
  root.style.setProperty('--space-lg', `var(--space-4)`);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [colorMode, setColorModeState] = useState<ColorMode>(DEFAULT_THEME_PREFS.colorMode);
  const [uiScale, setUiScaleState] = useState<UiScale>(DEFAULT_THEME_PREFS.uiScale);
  const [hasHydratedPrefs, setHasHydratedPrefs] = useState(false);

  useEffect(() => {
    const stored = readStoredPrefs();
    setColorModeState(stored.colorMode);
    setUiScaleState(stored.uiScale);
    setHasHydratedPrefs(true);
    applyThemeAttributes(stored.colorMode, stored.uiScale);
  }, []);

  useEffect(() => {
    if (!hasHydratedPrefs) return;
    applyThemeAttributes(colorMode, uiScale);
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(THEME_PREFS_STORAGE_KEY, JSON.stringify({ colorMode, uiScale }));
    const legacy = toLegacyTheme(colorMode, uiScale);
    if (legacy === 'default') window.localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
    else window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, legacy);
  }, [hasHydratedPrefs, colorMode, uiScale]);

  const setColorMode = useCallback((mode: ColorMode) => setColorModeState(mode), []);
  const setUiScale = useCallback((scale: UiScale) => setUiScaleState(scale), []);
  const setTheme = useCallback((theme: AuraTheme) => {
    const parsed = normalizeTheme(theme);
    setColorModeState(parsed.colorMode);
    setUiScaleState(parsed.uiScale);
  }, []);

  const theme = useMemo(() => toLegacyTheme(colorMode, uiScale), [colorMode, uiScale]);

  const value = useMemo<ThemeContextValue>(() => ({
    colorMode,
    uiScale,
    setColorMode,
    setUiScale,
    theme,
    setTheme,
  }), [colorMode, uiScale, setColorMode, setUiScale, theme, setTheme]);

  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
}
