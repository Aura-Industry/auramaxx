import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Legacy colors (preserved for backward compatibility)
        voltage: '#ccff00',
        void: '#0a0a0a',
        tyvek: '#ffffff',
        concrete: '#d4d4d8',
        surgical: '#00f0ff',
        alert: '#ff4d00',
        'clinical-blue': '#0047ff',
        'warning-orange': '#FF4D00',
        'tyvek-dim': '#F0F0F0',
        ink: '#050505',
        signal: '#00FF41',

        // Theme-aware colors using CSS variables
        theme: {
          accent: 'var(--color-accent, #ccff00)',
          'accent-foreground': 'var(--color-accent-foreground, #0a0a0a)',
          warning: 'var(--color-warning, #ff4d00)',
          'warning-foreground': 'var(--color-warning-foreground, #ffffff)',
          danger: 'var(--color-danger, #ef4444)',
          'danger-foreground': 'var(--color-danger-foreground, #ffffff)',
          success: 'var(--color-success, #00c853)',
          'success-foreground': 'var(--color-success-foreground, #ffffff)',
          info: 'var(--color-info, #0047ff)',
          'info-foreground': 'var(--color-info-foreground, #ffffff)',
          background: 'var(--color-background, #f5f5f5)',
          'background-alt': 'var(--color-background-alt, #e8e8e6)',
          surface: 'var(--color-surface, #ffffff)',
          'surface-alt': 'var(--color-surface-alt, #fafafa)',
          text: 'var(--color-text, #0a0a0a)',
          'text-muted': 'var(--color-text-muted, #6b7280)',
          'text-faint': 'var(--color-text-faint, #9ca3af)',
          border: 'var(--color-border, #d4d4d8)',
          'border-muted': 'var(--color-border-muted, #e5e5e5)',
          'border-focus': 'var(--color-border-focus, #0a0a0a)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      backgroundImage: {
        'noise': "url('data:image/svg+xml,%3Csvg viewBox=\"0 0 200 200\" xmlns=\"http://www.w3.org/2000/svg\"%3E%3Cfilter id=\"noiseFilter\"%3E%3CfeTurbulence type=\"fractalNoise\" baseFrequency=\"0.9\" numOctaves=\"3\" stitchTiles=\"stitch\"/%3E%3C/filter%3E%3Crect width=\"100%25\" height=\"100%25\" filter=\"url(%23noiseFilter)\" opacity=\"0.05\"/%3E%3C/svg%3E')",
        'grid-pattern': "linear-gradient(to right, #e5e5e5 1px, transparent 1px), linear-gradient(to bottom, #e5e5e5 1px, transparent 1px)",
        'grid-pattern-dark': "linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px)",
        'hazard-stripes': "repeating-linear-gradient(135deg, transparent, transparent 10px, rgba(204,255,0,0.06) 10px, rgba(204,255,0,0.06) 20px)",
      },
      animation: {
        'slam': 'slam 0.4s cubic-bezier(0.19, 1, 0.22, 1) forwards',
        'flash': 'flash 2s infinite',
        'ticker': 'ticker 30s linear infinite',
        'pulse-fast': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 3s linear infinite',
        'scan-vertical': 'scan-vertical 3s linear infinite',
        'app-focus': 'app-focus 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      keyframes: {
        slam: {
          '0%': { transform: 'scale(1.05) translateY(20px)', opacity: '0' },
          '100%': { transform: 'scale(1) translateY(0)', opacity: '1' },
        },
        ticker: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-100%)' },
        },
        flash: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
        'scan-vertical': {
          '0%': { top: '0', opacity: '0' },
          '10%': { opacity: '1' },
          '90%': { opacity: '1' },
          '100%': { top: '100%', opacity: '0' },
        },
        'app-focus': {
          '0%': { transform: 'scale(1)' },
          '40%': { transform: 'scale(1.03)' },
          '100%': { transform: 'scale(1)' },
        }
      }
    },
  },
  plugins: [],
};

export default config;
