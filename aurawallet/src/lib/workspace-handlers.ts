import { prisma } from './db';
import {
  WORKSPACE_EVENTS,
  WorkspaceEvent,
  WorkspaceData,
  AppData,
  AppUpdateData,
  WorkspaceStateRequestData,
  WorkspaceStateResponseData,
  WorkspaceImportData,
  createWorkspaceEvent,
} from './events';

/**
 * Handle incoming workspace WebSocket messages
 * Returns a response event if one should be sent back to the sender
 */
export async function handleWorkspaceMessage(
  msg: WorkspaceEvent
): Promise<WorkspaceEvent | null> {
  console.log(`[WS] Handling workspace message: ${msg.type}`);

  switch (msg.type) {
    case WORKSPACE_EVENTS.STATE_REQUEST:
      return handleStateRequest(msg.data as WorkspaceStateRequestData);

    case WORKSPACE_EVENTS.WORKSPACE_CREATED:
      await handleWorkspaceCreated(msg.data as WorkspaceData);
      return null;

    case WORKSPACE_EVENTS.WORKSPACE_DELETED:
      await handleWorkspaceDeleted(msg.data as { workspaceId: string });
      return null;

    case WORKSPACE_EVENTS.WORKSPACE_UPDATED:
      await handleWorkspaceUpdated(msg.data as WorkspaceData);
      return null;

    case WORKSPACE_EVENTS.APP_ADDED:
      await handleAppAdded(msg.data as AppData);
      return null;

    case WORKSPACE_EVENTS.APP_REMOVED:
      await handleAppRemoved(msg.data as { appId: string });
      return null;

    case WORKSPACE_EVENTS.APP_UPDATED:
      await handleAppUpdated(msg.data as AppUpdateData);
      return null;

    case WORKSPACE_EVENTS.WORKSPACE_SAVE:
      await handleWorkspaceSave(msg.data as { workspaceId: string });
      return null;

    case WORKSPACE_EVENTS.WORKSPACE_IMPORT:
      await handleWorkspaceImport(msg.data as WorkspaceImportData);
      return null;

    default:
      console.warn(`[WS] Unknown workspace event type: ${msg.type}`);
      return null;
  }
}

async function handleStateRequest(
  data: WorkspaceStateRequestData
): Promise<WorkspaceEvent<WorkspaceStateResponseData>> {
  // Get all workspaces
  const workspaces = await prisma.workspace.findMany({
    orderBy: { order: 'asc' },
  });

  // Find the default or first workspace
  let activeWorkspaceId: string = data.workspaceId ?? '';
  if (!activeWorkspaceId) {
    const defaultWorkspace = workspaces.find((w: any) => w.isDefault) || workspaces[0];
    activeWorkspaceId = defaultWorkspace?.id || '';
  }

  // Get apps for the active workspace
  const apps = activeWorkspaceId
    ? await prisma.workspaceApp.findMany({
        where: { workspaceId: activeWorkspaceId },
      })
    : [];

  const response: WorkspaceStateResponseData = {
    requestId: data.requestId,
    workspaces: workspaces.map((w: any) => ({
      id: w.id,
      name: w.name,
      slug: w.slug,
      icon: w.icon || undefined,
      emoji: w.emoji || undefined,
      color: w.color || undefined,
      order: w.order,
      isDefault: w.isDefault,
      isCloseable: w.isCloseable,
    })),
    activeWorkspaceId,
    apps: apps.map((w: any) => ({
      id: w.id,
      workspaceId: w.workspaceId,
      appType: w.appType,
      x: w.x,
      y: w.y,
      width: w.width,
      height: w.height,
      zIndex: w.zIndex,
      isVisible: w.isVisible,
      isLocked: w.isLocked,
      config: w.config ? JSON.parse(w.config) : undefined,
    })),
  };

  return createWorkspaceEvent(WORKSPACE_EVENTS.STATE_RESPONSE, response, 'server');
}

async function handleWorkspaceCreated(data: WorkspaceData): Promise<void> {
  // Generate a unique slug from the name
  const baseSlug = data.slug || data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let slug = baseSlug;
  let counter = 1;

  // Ensure slug is unique
  while (await prisma.workspace.findUnique({ where: { slug } })) {
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  // Get the next order value
  const maxOrder = await prisma.workspace.aggregate({
    _max: { order: true },
  });
  const order = data.order ?? (maxOrder._max.order ?? -1) + 1;

  await prisma.workspace.create({
    data: {
      id: data.id,
      name: data.name,
      slug,
      icon: data.icon,
      emoji: data.emoji,
      color: data.color,
      order,
      isDefault: data.isDefault ?? false,
      isCloseable: data.isCloseable ?? true,
    },
  });

  console.log(`[WS] Created workspace: ${data.name} (${slug})`);
}

async function handleWorkspaceDeleted(data: { workspaceId: string }): Promise<void> {
  // Cascade delete will remove associated apps
  await prisma.workspace.delete({
    where: { id: data.workspaceId },
  });

  console.log(`[WS] Deleted workspace: ${data.workspaceId}`);
}

async function handleWorkspaceUpdated(data: WorkspaceData): Promise<void> {
  // Only include fields that are explicitly provided (not undefined)
  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.icon !== undefined) updateData.icon = data.icon;
  if (data.emoji !== undefined) updateData.emoji = data.emoji || null;
  if (data.color !== undefined) updateData.color = data.color || null;
  if (data.order !== undefined) updateData.order = data.order;
  if (data.isDefault !== undefined) updateData.isDefault = data.isDefault;
  if (data.isCloseable !== undefined) updateData.isCloseable = data.isCloseable;

  await prisma.workspace.update({
    where: { id: data.id },
    data: updateData,
  });

  console.log(`[WS] Updated workspace: ${data.id}`);
}

async function handleAppAdded(data: AppData): Promise<void> {
  // Get the next zIndex for this workspace
  const maxZ = await prisma.workspaceApp.aggregate({
    where: { workspaceId: data.workspaceId },
    _max: { zIndex: true },
  });
  const zIndex = data.zIndex ?? (maxZ._max.zIndex ?? 9) + 1;

  await prisma.workspaceApp.create({
    data: {
      id: data.id,
      workspaceId: data.workspaceId,
      appType: data.appType,
      x: data.x ?? 20,
      y: data.y ?? 20,
      width: data.width ?? 320,
      height: data.height ?? 280,
      zIndex,
      isVisible: data.isVisible ?? true,
      isLocked: data.isLocked ?? false,
      config: data.config ? JSON.stringify(data.config) : null,
    },
  });

  console.log(`[WS] Added app: ${data.appType} to workspace ${data.workspaceId}`);
}

async function handleAppRemoved(data: { appId: string }): Promise<void> {
  await prisma.workspaceApp.delete({
    where: { id: data.appId },
  });

  console.log(`[WS] Removed app: ${data.appId}`);
}

async function handleAppUpdated(data: AppUpdateData): Promise<void> {
  const updateData: Record<string, unknown> = {};

  if (data.x !== undefined) updateData.x = data.x;
  if (data.y !== undefined) updateData.y = data.y;
  if (data.width !== undefined) updateData.width = data.width;
  if (data.height !== undefined) updateData.height = data.height;
  if (data.zIndex !== undefined) updateData.zIndex = data.zIndex;
  if (data.isVisible !== undefined) updateData.isVisible = data.isVisible;
  if (data.isLocked !== undefined) updateData.isLocked = data.isLocked;
  if (data.config !== undefined) updateData.config = JSON.stringify(data.config);

  await prisma.workspaceApp.update({
    where: { id: data.appId },
    data: updateData,
  });

  console.log(`[WS] Updated app: ${data.appId}`);
}

async function handleWorkspaceSave(data: { workspaceId: string }): Promise<void> {
  // Touch the updatedAt timestamp to indicate a save
  await prisma.workspace.update({
    where: { id: data.workspaceId },
    data: { updatedAt: new Date() },
  });

  console.log(`[WS] Saved workspace: ${data.workspaceId}`);
}

async function handleWorkspaceImport(data: WorkspaceImportData): Promise<void> {
  const { workspace, apps } = data;

  // Create the workspace
  await handleWorkspaceCreated(workspace);

  // Create all apps
  for (const app of apps) {
    await handleAppAdded({
      ...app,
      workspaceId: workspace.id,
    });
  }

  console.log(`[WS] Imported workspace: ${workspace.name} with ${apps.length} apps`);
}

/**
 * Ensure a default "HOME" workspace exists
 */
export async function ensureDefaultWorkspace(): Promise<void> {
  const existing = await prisma.workspace.findFirst({
    where: { isDefault: true },
  });

  if (!existing) {
    await prisma.workspace.create({
      data: {
        name: 'HOME',
        slug: 'home',
        icon: 'Home',
        order: 0,
        isDefault: true,
        isCloseable: false,
      },
    });
    console.log('[WS] Created default HOME workspace');
  }
}
