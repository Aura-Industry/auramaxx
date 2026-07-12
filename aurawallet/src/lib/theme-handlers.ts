import { prisma } from './db';
import {
  THEME_EVENTS,
  ThemeEvent,
  ThemeRequestData,
  ThemeResponseData,
  ThemeModeChangedData,
  ThemeAccentChangedData,
  WorkspaceThemeUpdatedData,
  createThemeEvent,
} from './events';

/**
 * Handle incoming theme WebSocket messages
 * Returns a response event if one should be sent back to the sender
 */
export async function handleThemeMessage(
  msg: ThemeEvent
): Promise<ThemeEvent | null> {
  console.log(`[WS] Handling theme message: ${msg.type}`);

  switch (msg.type) {
    case THEME_EVENTS.THEME_REQUEST:
      return handleThemeRequest(msg.data as ThemeRequestData);

    case THEME_EVENTS.THEME_MODE_CHANGED:
      await handleThemeModeChanged(msg.data as ThemeModeChangedData);
      return null;

    case THEME_EVENTS.THEME_ACCENT_CHANGED:
      await handleThemeAccentChanged(msg.data as ThemeAccentChangedData);
      return null;

    case THEME_EVENTS.WORKSPACE_THEME_UPDATED:
      await handleWorkspaceThemeUpdated(msg.data as WorkspaceThemeUpdatedData);
      return null;

    default:
      console.warn(`[WS] Unknown theme event type: ${msg.type}`);
      return null;
  }
}

/**
 * Ensure the global theme config exists
 */
async function ensureThemeConfig() {
  const config = await prisma.themeConfig.findUnique({
    where: { id: 'global' },
  });

  if (!config) {
    await prisma.themeConfig.create({
      data: {
        id: 'global',
        activeThemeId: 'light',
        accentColor: '#ccff00',
      },
    });
    console.log('[Theme] Created default theme config');
  }

  return config || {
    id: 'global',
    activeThemeId: 'light',
    accentColor: '#ccff00',
  };
}

/**
 * Handle theme:request - return current theme state
 */
async function handleThemeRequest(
  data: ThemeRequestData
): Promise<ThemeEvent<ThemeResponseData>> {
  const config = await ensureThemeConfig();

  const response: ThemeResponseData = {
    requestId: data.requestId,
    activeThemeId: config.activeThemeId,
    accentColor: config.accentColor,
    mode: config.activeThemeId === 'dark' ? 'dark' : 'light',
  };

  return createThemeEvent(THEME_EVENTS.THEME_RESPONSE, response, 'server');
}

/**
 * Handle theme:mode:changed - update theme mode (light/dark)
 */
async function handleThemeModeChanged(data: ThemeModeChangedData): Promise<void> {
  await ensureThemeConfig();

  await prisma.themeConfig.update({
    where: { id: 'global' },
    data: {
      activeThemeId: data.mode,
    },
  });

  console.log(`[Theme] Mode changed to: ${data.mode}`);
}

/**
 * Handle theme:accent:changed - update accent color
 */
async function handleThemeAccentChanged(data: ThemeAccentChangedData): Promise<void> {
  await ensureThemeConfig();

  await prisma.themeConfig.update({
    where: { id: 'global' },
    data: {
      accentColor: data.accent,
    },
  });

  console.log(`[Theme] Accent changed to: ${data.accent}`);
}

/**
 * Handle workspace:theme:updated - update per-workspace theme overrides
 */
async function handleWorkspaceThemeUpdated(data: WorkspaceThemeUpdatedData): Promise<void> {
  const existing = await prisma.workspaceTheme.findUnique({
    where: { workspaceId: data.workspaceId },
  });

  if (existing) {
    // Update existing
    const updateData: Record<string, unknown> = {};
    if (data.mode !== undefined) updateData.mode = data.mode;
    if (data.accent !== undefined) updateData.accent = data.accent;
    if (data.overrides !== undefined) updateData.overrides = data.overrides;

    await prisma.workspaceTheme.update({
      where: { workspaceId: data.workspaceId },
      data: updateData,
    });
  } else {
    // Create new
    await prisma.workspaceTheme.create({
      data: {
        workspaceId: data.workspaceId,
        mode: data.mode,
        accent: data.accent,
        overrides: data.overrides,
      },
    });
  }

  console.log(`[Theme] Workspace theme updated for: ${data.workspaceId}`);
}

/**
 * Get global theme configuration
 */
export async function getThemeConfig() {
  return ensureThemeConfig();
}

/**
 * Get workspace-specific theme override
 */
export async function getWorkspaceTheme(workspaceId: string) {
  return prisma.workspaceTheme.findUnique({
    where: { workspaceId },
  });
}
