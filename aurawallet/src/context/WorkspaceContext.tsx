'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  ReactNode,
} from 'react';
import { useWebSocket } from './WebSocketContext';
import {
  WORKSPACE_EVENTS,
  WorkspaceData,
  AppData,
  AppUpdateData,
  WorkspaceStateResponseData,
  createWorkspaceEvent,
} from '@/lib/events';
import { isSingletonApp } from '@/lib/app-registry';

export interface AppState {
  id: string;
  workspaceId: string;
  appType: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  isVisible: boolean;
  isLocked: boolean;
  config?: Record<string, unknown>;
}

export interface WorkspaceState {
  id: string;
  name: string;
  slug: string;
  icon?: string;
  emoji?: string;
  color?: string;
  order: number;
  isDefault: boolean;
  isCloseable: boolean;
}

interface WorkspaceContextValue {
  workspaces: WorkspaceState[];
  activeWorkspaceId: string;
  apps: AppState[];
  loading: boolean;

  // Workspace actions
  createWorkspace: (name: string, icon?: string) => void;
  deleteWorkspace: (id: string) => void;
  updateWorkspace: (id: string, updates: Partial<WorkspaceData>) => void;
  switchWorkspace: (id: string) => void;

  // App actions
  /**
   * Add a app to the current workspace.
   * - Singleton apps (logs, agentKeys, etc.): ID defaults to app type, brings to front if exists
   * - Multi-instance apps (iframe, dynamic, custom): ID can be custom (e.g., 'wallet:0x123') or auto-generated
   */
  addApp: (type: string, config?: Record<string, unknown>, position?: { x: number; y: number }, customId?: string) => void;
  removeApp: (appId: string) => void;
  updateApp: (appId: string, updates: Partial<AppUpdateData>) => void;
  bringToFront: (appId: string) => void;
  /** Reorder all apps in a grid layout to prevent overlap */
  tidyApps: () => void;

  // Persistence
  saveWorkspace: () => void;
  refreshState: () => void;
  exportWorkspace: () => { workspace: WorkspaceState; apps: AppState[] } | null;
  importWorkspace: (data: { workspace: WorkspaceData; apps: AppData[] }) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

// Default app sizes by type
const DEFAULT_APP_SIZES: Record<string, { width: number; height: number }> = {
  logs: { width: 600, height: 300 },
  send: { width: 320, height: 280 },
  agentKeys: { width: 340, height: 400 },
  iframe: { width: 400, height: 300 },
  dynamic: { width: 300, height: 200 },
};

// Debounce helper
function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
  let timeoutId: NodeJS.Timeout;
  return ((...args: unknown[]) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  }) as T;
}

interface WorkspaceProviderProps {
  children: ReactNode;
}

export function WorkspaceProvider({ children }: WorkspaceProviderProps) {
  const { connected, subscribe, send } = useWebSocket();

  const [workspaces, setWorkspaces] = useState<WorkspaceState[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>('');
  const [apps, setApps] = useState<AppState[]>([]);
  const [loading, setLoading] = useState(true);
  const [topZIndex, setTopZIndex] = useState(100);

  const pendingRequests = useRef<Map<string, (data: WorkspaceStateResponseData) => void>>(new Map());

  // Request state from server
  const refreshState = useCallback(() => {
    if (!connected) return;

    const requestId = `req-${Date.now()}`;

    // Set up response handler
    pendingRequests.current.set(requestId, (data: WorkspaceStateResponseData) => {
      setWorkspaces(data.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        icon: w.icon,
        emoji: w.emoji,
        color: w.color,
        order: w.order ?? 0,
        isDefault: w.isDefault ?? false,
        isCloseable: w.isCloseable ?? true,
      })));
      setActiveWorkspaceId(data.activeWorkspaceId);
      setApps(data.apps.map((w) => ({
        id: w.id!,
        workspaceId: w.workspaceId,
        appType: w.appType,
        x: w.x ?? 20,
        y: w.y ?? 20,
        width: w.width ?? 320,
        height: w.height ?? 280,
        zIndex: w.zIndex ?? 10,
        isVisible: w.isVisible ?? true,
        isLocked: w.isLocked ?? false,
        config: w.config as Record<string, unknown> | undefined,
      })));

      // Update topZIndex
      const maxZ = Math.max(...data.apps.map((w) => w.zIndex ?? 10), 10);
      setTopZIndex(maxZ + 1);
      setLoading(false);
    });

    send(createWorkspaceEvent(WORKSPACE_EVENTS.STATE_REQUEST, {
      requestId,
      workspaceId: activeWorkspaceId || undefined,
    }, 'ui'));
  }, [connected, send, activeWorkspaceId]);

  // Subscribe to workspace events
  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Handle state response
    unsubscribers.push(subscribe(WORKSPACE_EVENTS.STATE_RESPONSE, (event) => {
      const data = event.data as WorkspaceStateResponseData;
      const handler = pendingRequests.current.get(data.requestId);
      if (handler) {
        handler(data);
        pendingRequests.current.delete(data.requestId);
      }
    }));

    // Handle workspace created (from other clients)
    unsubscribers.push(subscribe(WORKSPACE_EVENTS.WORKSPACE_CREATED, (event) => {
      const data = event.data as WorkspaceData;
      setWorkspaces((prev) => {
        if (prev.some((w) => w.id === data.id)) return prev;
        return [...prev, {
          id: data.id,
          name: data.name,
          slug: data.slug,
          icon: data.icon,
          emoji: data.emoji,
          color: data.color,
          order: data.order ?? prev.length,
          isDefault: data.isDefault ?? false,
          isCloseable: data.isCloseable ?? true,
        }];
      });
    }));

    // Handle workspace deleted
    unsubscribers.push(subscribe(WORKSPACE_EVENTS.WORKSPACE_DELETED, (event) => {
      const data = event.data as { workspaceId: string };
      setWorkspaces((prev) => prev.filter((w) => w.id !== data.workspaceId));
      setApps((prev) => prev.filter((w) => w.workspaceId !== data.workspaceId));
      // Switch to first workspace if active was deleted
      setActiveWorkspaceId((prev) => {
        if (prev === data.workspaceId) {
          const remaining = workspaces.filter((w) => w.id !== data.workspaceId);
          return remaining[0]?.id || '';
        }
        return prev;
      });
    }));

    // Handle workspace updated
    unsubscribers.push(subscribe(WORKSPACE_EVENTS.WORKSPACE_UPDATED, (event) => {
      const data = event.data as WorkspaceData;
      setWorkspaces((prev) => prev.map((w) =>
        w.id === data.id
          ? {
              ...w,
              name: data.name ?? w.name,
              icon: data.icon ?? w.icon,
              emoji: data.emoji ?? w.emoji,
              color: data.color ?? w.color,
              order: data.order ?? w.order,
            }
          : w
      ));
    }));

    // Handle app added
    unsubscribers.push(subscribe(WORKSPACE_EVENTS.APP_ADDED, (event) => {
      const data = event.data as AppData;
      if (data.workspaceId !== activeWorkspaceId) return;

      setApps((prev) => {
        if (data.id && prev.some((w) => w.id === data.id)) return prev;
        return [...prev, {
          id: data.id || `app-${Date.now()}`,
          workspaceId: data.workspaceId,
          appType: data.appType,
          x: data.x ?? 20,
          y: data.y ?? 20,
          width: data.width ?? 320,
          height: data.height ?? 280,
          zIndex: data.zIndex ?? topZIndex,
          isVisible: data.isVisible ?? true,
          isLocked: data.isLocked ?? false,
          config: data.config as Record<string, unknown> | undefined,
        }];
      });
      setTopZIndex((prev) => prev + 1);
    }));

    // Handle app removed
    unsubscribers.push(subscribe(WORKSPACE_EVENTS.APP_REMOVED, (event) => {
      const data = event.data as { appId: string };
      setApps((prev) => prev.filter((w) => w.id !== data.appId));
    }));

    // Handle app updated
    unsubscribers.push(subscribe(WORKSPACE_EVENTS.APP_UPDATED, (event) => {
      const data = event.data as AppUpdateData;
      setApps((prev) => prev.map((w) => {
        if (w.id !== data.appId) return w;
        return {
          ...w,
          x: data.x ?? w.x,
          y: data.y ?? w.y,
          width: data.width ?? w.width,
          height: data.height ?? w.height,
          zIndex: data.zIndex ?? w.zIndex,
          isVisible: data.isVisible ?? w.isVisible,
          isLocked: data.isLocked ?? w.isLocked,
          config: data.config ?? w.config,
        };
      }));
    }));

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [subscribe, activeWorkspaceId, topZIndex, workspaces]);

  // Request initial state when connected
  useEffect(() => {
    if (connected) {
      refreshState();
    }
  }, [connected, refreshState]);

  // Debounced save to database
  const debouncedSave = useCallback(
    debounce(() => {
      if (!activeWorkspaceId) return;
      send(createWorkspaceEvent(WORKSPACE_EVENTS.WORKSPACE_SAVE, {
        workspaceId: activeWorkspaceId,
      }, 'ui'));
    }, 500),
    [activeWorkspaceId, send]
  );

  // Workspace actions
  const createWorkspace = useCallback((name: string, icon?: string) => {
    const id = `ws-${Date.now()}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    const newWorkspace: WorkspaceState = {
      id,
      name,
      slug,
      icon,
      order: workspaces.length,
      isDefault: false,
      isCloseable: true,
    };

    // Optimistic update
    setWorkspaces((prev) => [...prev, newWorkspace]);
    setActiveWorkspaceId(id);
    setApps([]);

    // Send to server
    send(createWorkspaceEvent(WORKSPACE_EVENTS.WORKSPACE_CREATED, {
      id,
      name,
      slug,
      icon,
      order: workspaces.length,
      isDefault: false,
      isCloseable: true,
    }, 'ui'));
  }, [workspaces.length, send]);

  const deleteWorkspace = useCallback((id: string) => {
    const workspace = workspaces.find((w) => w.id === id);
    if (!workspace?.isCloseable) return;

    // Optimistic update
    setWorkspaces((prev) => prev.filter((w) => w.id !== id));
    setApps((prev) => prev.filter((w) => w.workspaceId !== id));

    if (activeWorkspaceId === id) {
      const remaining = workspaces.filter((w) => w.id !== id);
      setActiveWorkspaceId(remaining[0]?.id || '');
    }

    // Send to server
    send(createWorkspaceEvent(WORKSPACE_EVENTS.WORKSPACE_DELETED, {
      workspaceId: id,
    }, 'ui'));
  }, [workspaces, activeWorkspaceId, send]);

  const updateWorkspace = useCallback((id: string, updates: Partial<WorkspaceData>) => {
    // Filter out undefined values to avoid overwriting existing data
    const definedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined)
    );

    setWorkspaces((prev) => prev.map((w) =>
      w.id === id ? { ...w, ...definedUpdates } : w
    ));

    const workspace = workspaces.find((w) => w.id === id);
    if (workspace) {
      send(createWorkspaceEvent(WORKSPACE_EVENTS.WORKSPACE_UPDATED, {
        id,
        name: updates.name ?? workspace.name,
        slug: updates.slug ?? workspace.slug,
        icon: updates.icon ?? workspace.icon,
        emoji: updates.emoji ?? workspace.emoji,
        color: updates.color ?? workspace.color,
        order: updates.order ?? workspace.order,
        isDefault: updates.isDefault ?? workspace.isDefault,
        isCloseable: updates.isCloseable ?? workspace.isCloseable,
      }, 'ui'));
    }
  }, [workspaces, send]);

  const switchWorkspace = useCallback((id: string) => {
    if (id === activeWorkspaceId) return;

    setActiveWorkspaceId(id);
    setLoading(true);

    // Request apps for the new workspace
    const requestId = `req-${Date.now()}`;
    pendingRequests.current.set(requestId, (data: WorkspaceStateResponseData) => {
      setApps(data.apps.map((w) => ({
        id: w.id!,
        workspaceId: w.workspaceId,
        appType: w.appType,
        x: w.x ?? 20,
        y: w.y ?? 20,
        width: w.width ?? 320,
        height: w.height ?? 280,
        zIndex: w.zIndex ?? 10,
        isVisible: w.isVisible ?? true,
        isLocked: w.isLocked ?? false,
        config: w.config as Record<string, unknown> | undefined,
      })));
      const maxZ = Math.max(...data.apps.map((w) => w.zIndex ?? 10), 10);
      setTopZIndex(maxZ + 1);
      setLoading(false);
    });

    send(createWorkspaceEvent(WORKSPACE_EVENTS.STATE_REQUEST, {
      requestId,
      workspaceId: id,
    }, 'ui'));
  }, [activeWorkspaceId, send]);

  // Bring app to front (defined before addApp since addApp uses it)
  const bringToFront = useCallback((appId: string) => {
    setApps((prev) => prev.map((w) =>
      w.id === appId ? { ...w, zIndex: topZIndex } : w
    ));
    setTopZIndex((prev) => prev + 1);

    send(createWorkspaceEvent(WORKSPACE_EVENTS.APP_UPDATED, {
      appId,
      zIndex: topZIndex,
    }, 'ui'));

    debouncedSave();
  }, [topZIndex, send, debouncedSave]);

  // Tidy apps - arrange in a grid to prevent overlap
  const tidyApps = useCallback(() => {
    // Get fresh state to avoid stale closure issues
    setApps(prevApps => {
      const currentApps = prevApps.filter(w => w.workspaceId === activeWorkspaceId && w.isVisible);
      if (currentApps.length === 0) return prevApps;

      const PADDING = 20; // Gap between apps
      const START_X = 20;
      const START_Y = 20;
      // Use viewport width minus some margin, with a reasonable minimum
      const CANVAS_WIDTH = Math.max(800, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 100);

      // Sort apps by area (largest first) for better packing
      const sorted = [...currentApps].sort((a, b) => {
        // Primary: sort by area descending (pack larger apps first)
        const areaA = a.width * a.height;
        const areaB = b.width * b.height;
        if (areaA !== areaB) return areaB - areaA;
        // Secondary: maintain original order by position
        const rowA = Math.floor(a.y / 100);
        const rowB = Math.floor(b.y / 100);
        if (rowA !== rowB) return rowA - rowB;
        return a.x - b.x;
      });

      // Simple row-based packing algorithm
      let currentX = START_X;
      let currentY = START_Y;
      let rowHeight = 0;

      const updates: Array<{ id: string; x: number; y: number; zIndex: number }> = [];

      sorted.forEach((app, index) => {
        // Check if app fits in current row
        if (currentX + app.width > CANVAS_WIDTH && currentX !== START_X) {
          // Move to next row
          currentX = START_X;
          currentY += rowHeight + PADDING;
          rowHeight = 0;
        }

        updates.push({
          id: app.id,
          x: currentX,
          y: currentY,
          zIndex: 10 + index, // Reset z-index in order
        });

        // Advance position
        currentX += app.width + PADDING;
        rowHeight = Math.max(rowHeight, app.height);
      });

      // Reset topZIndex
      setTopZIndex(10 + updates.length);

      // Send updates to server (batched after state update)
      setTimeout(() => {
        updates.forEach(update => {
          send(createWorkspaceEvent(WORKSPACE_EVENTS.APP_UPDATED, {
            appId: update.id,
            x: update.x,
            y: update.y,
            zIndex: update.zIndex,
          }, 'ui'));
        });
        debouncedSave();
      }, 0);

      // Apply all updates and return new state
      return prevApps.map(w => {
        const update = updates.find(u => u.id === w.id);
        if (update) {
          return { ...w, x: update.x, y: update.y, zIndex: update.zIndex };
        }
        return w;
      });
    });
  }, [activeWorkspaceId, send, debouncedSave]);

  // App actions
  const addApp = useCallback((
    type: string,
    config?: Record<string, unknown>,
    position?: { x: number; y: number },
    customId?: string
  ) => {
    if (!activeWorkspaceId) return;

    const isSingleton = isSingletonApp(type);

    // For singleton apps, use type as ID; for multi-instance, use custom ID or generate one
    const id = isSingleton ? type : (customId || `${type}-${Date.now()}`);

    // Check if app with this ID already exists
    const existing = apps.find(w => w.id === id);
    if (existing) {
      // Bring existing app to front instead of creating duplicate
      bringToFront(id);
      return;
    }

    const defaultSize = DEFAULT_APP_SIZES[type] || DEFAULT_APP_SIZES.iframe;
    const x = position?.x ?? 20 + apps.length * 20;
    const y = position?.y ?? 20 + apps.length * 20;
    const inferredInstalledPath = type.startsWith('installed:') ? type.slice(10) : null;
    const resolvedConfig = inferredInstalledPath
      ? { appPath: inferredInstalledPath, appName: inferredInstalledPath, ...config }
      : config;

    const newApp: AppState = {
      id,
      workspaceId: activeWorkspaceId,
      appType: type,
      x,
      y,
      width: defaultSize.width,
      height: defaultSize.height,
      zIndex: topZIndex,
      isVisible: true,
      isLocked: false,
      config: resolvedConfig,
    };

    // Optimistic update
    setApps((prev) => [...prev, newApp]);
    setTopZIndex((prev) => prev + 1);

    // Send to server
    send(createWorkspaceEvent(WORKSPACE_EVENTS.APP_ADDED, {
      id,
      workspaceId: activeWorkspaceId,
      appType: type,
      x,
      y,
      width: defaultSize.width,
      height: defaultSize.height,
      zIndex: topZIndex,
      isVisible: true,
      isLocked: false,
      config: resolvedConfig,
    }, 'ui'));

    debouncedSave();
  }, [activeWorkspaceId, apps, topZIndex, send, debouncedSave, bringToFront]);

  const removeApp = useCallback((appId: string) => {
    // Optimistic update
    setApps((prev) => prev.filter((w) => w.id !== appId));

    // Send to server
    send(createWorkspaceEvent(WORKSPACE_EVENTS.APP_REMOVED, {
      appId,
    }, 'ui'));

    debouncedSave();
  }, [send, debouncedSave]);

  const updateApp = useCallback((appId: string, updates: Partial<AppUpdateData>) => {
    // Optimistic update
    setApps((prev) => prev.map((w) => {
      if (w.id !== appId) return w;
      return {
        ...w,
        x: updates.x ?? w.x,
        y: updates.y ?? w.y,
        width: updates.width ?? w.width,
        height: updates.height ?? w.height,
        zIndex: updates.zIndex ?? w.zIndex,
        isVisible: updates.isVisible ?? w.isVisible,
        isLocked: updates.isLocked ?? w.isLocked,
        config: updates.config ?? w.config,
      };
    }));

    // Send to server
    send(createWorkspaceEvent(WORKSPACE_EVENTS.APP_UPDATED, {
      appId,
      ...updates,
    }, 'ui'));

    debouncedSave();
  }, [send, debouncedSave]);

  const saveWorkspace = useCallback(() => {
    if (!activeWorkspaceId) return;
    send(createWorkspaceEvent(WORKSPACE_EVENTS.WORKSPACE_SAVE, {
      workspaceId: activeWorkspaceId,
    }, 'ui'));
  }, [activeWorkspaceId, send]);

  const exportWorkspace = useCallback(() => {
    const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
    if (!workspace) return null;

    return {
      workspace,
      apps: apps.filter((w) => w.workspaceId === activeWorkspaceId),
    };
  }, [workspaces, apps, activeWorkspaceId]);

  const importWorkspace = useCallback((data: { workspace: WorkspaceData; apps: AppData[] }) => {
    send(createWorkspaceEvent(WORKSPACE_EVENTS.WORKSPACE_IMPORT, data, 'ui'));
    // Refresh to get the imported workspace
    setTimeout(refreshState, 100);
  }, [send, refreshState]);

  const value: WorkspaceContextValue = {
    workspaces,
    activeWorkspaceId,
    apps,
    loading,

    createWorkspace,
    deleteWorkspace,
    updateWorkspace,
    switchWorkspace,

    addApp,
    removeApp,
    updateApp,
    bringToFront,
    tidyApps,

    saveWorkspace,
    refreshState,
    exportWorkspace,
    importWorkspace,
  };

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}
