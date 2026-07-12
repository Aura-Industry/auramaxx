'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from 'react';
import {
  Theme,
  DEFAULT_LIGHT_THEME,
  getThemeById,
  applyThemeToCSSVariables,
  createThemeWithAccent,
} from '@/lib/theme';
import { useWebSocket } from './WebSocketContext';
import { THEME_EVENTS, createThemeEvent } from '@/lib/events';

interface ThemeContextValue {
  theme: Theme;
  mode: 'light' | 'dark';
  accent: string;
  setMode: (mode: 'light' | 'dark') => void;
  setAccent: (accent: string) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const { subscribe, send, connected } = useWebSocket();

  const [mode, setModeState] = useState<'light' | 'dark'>('light');
  const [accent, setAccentState] = useState('#ccff00');
  const [theme, setTheme] = useState<Theme>(DEFAULT_LIGHT_THEME);
  const [initialized, setInitialized] = useState(false);

  // Request theme from server on connect
  useEffect(() => {
    if (connected && !initialized) {
      const requestId = `theme-init-${Date.now()}`;
      send(
        createThemeEvent(
          THEME_EVENTS.THEME_REQUEST,
          { requestId },
          'ui'
        )
      );
    }
  }, [connected, initialized, send]);

  // Subscribe to theme events
  useEffect(() => {
    const unsubscribe = subscribe(THEME_EVENTS.THEME_RESPONSE, (event) => {
      if (event.type === THEME_EVENTS.THEME_RESPONSE) {
        const data = event.data as {
          activeThemeId: string;
          accentColor: string;
          mode: 'light' | 'dark';
        };
        setModeState(data.mode);
        setAccentState(data.accentColor);
        setInitialized(true);
      }
    });

    return unsubscribe;
  }, [subscribe]);

  // Subscribe to mode changes from other clients/agents
  useEffect(() => {
    const unsubscribe = subscribe(THEME_EVENTS.THEME_MODE_CHANGED, (event) => {
      if (event.type === THEME_EVENTS.THEME_MODE_CHANGED) {
        const data = event.data as { mode: 'light' | 'dark' };
        setModeState(data.mode);
      }
    });

    return unsubscribe;
  }, [subscribe]);

  // Subscribe to accent changes from other clients/agents
  useEffect(() => {
    const unsubscribe = subscribe(THEME_EVENTS.THEME_ACCENT_CHANGED, (event) => {
      if (event.type === THEME_EVENTS.THEME_ACCENT_CHANGED) {
        const data = event.data as { accent: string };
        setAccentState(data.accent);
      }
    });

    return unsubscribe;
  }, [subscribe]);

  // Update theme object when mode or accent changes
  useEffect(() => {
    const baseTheme = getThemeById(mode);
    const newTheme = createThemeWithAccent(baseTheme, accent);
    setTheme(newTheme);
    applyThemeToCSSVariables(newTheme);
  }, [mode, accent]);

  // Set mode and broadcast to other clients
  const setMode = useCallback(
    (newMode: 'light' | 'dark') => {
      setModeState(newMode);
      send(
        createThemeEvent(
          THEME_EVENTS.THEME_MODE_CHANGED,
          { mode: newMode },
          'ui'
        )
      );
    },
    [send]
  );

  // Set accent and broadcast to other clients
  const setAccent = useCallback(
    (newAccent: string) => {
      setAccentState(newAccent);
      send(
        createThemeEvent(
          THEME_EVENTS.THEME_ACCENT_CHANGED,
          { accent: newAccent },
          'ui'
        )
      );
    },
    [send]
  );

  // Toggle between light and dark mode
  const toggleMode = useCallback(() => {
    const newMode = mode === 'light' ? 'dark' : 'light';
    setMode(newMode);
  }, [mode, setMode]);

  const value: ThemeContextValue = {
    theme,
    mode,
    accent,
    setMode,
    setAccent,
    toggleMode,
  };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
