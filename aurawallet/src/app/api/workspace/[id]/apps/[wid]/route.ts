import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { requireWorkspaceAdmin } from '../../../auth';

const prisma = new PrismaClient();

// PATCH /api/workspace/[id]/apps/[wid] - Update app
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; wid: string }> }
) {
  try {
    const unauthorized = await requireWorkspaceAdmin(request);
    if (unauthorized) return unauthorized;

    const { id: workspaceId, wid: appId } = await params;
    const body = await request.json();
    const { x, y, width, height, zIndex, isVisible, isLocked, config } = body;

    // Verify app exists and belongs to workspace
    const existing = await prisma.workspaceApp.findUnique({
      where: { id: appId },
    });

    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'App not found' },
        { status: 404 }
      );
    }

    if (existing.workspaceId !== workspaceId) {
      return NextResponse.json(
        { success: false, error: 'App does not belong to this workspace' },
        { status: 400 }
      );
    }

    const updateData: Record<string, unknown> = {};
    if (x !== undefined) updateData.x = x;
    if (y !== undefined) updateData.y = y;
    if (width !== undefined) updateData.width = width;
    if (height !== undefined) updateData.height = height;
    if (zIndex !== undefined) updateData.zIndex = zIndex;
    if (isVisible !== undefined) updateData.isVisible = isVisible;
    if (isLocked !== undefined) updateData.isLocked = isLocked;
    if (config !== undefined) updateData.config = JSON.stringify(config);

    const app = await prisma.workspaceApp.update({
      where: { id: appId },
      data: updateData,
    });

    return NextResponse.json({
      success: true,
      app: {
        id: app.id,
        workspaceId: app.workspaceId,
        appType: app.appType,
        x: app.x,
        y: app.y,
        width: app.width,
        height: app.height,
        zIndex: app.zIndex,
        isVisible: app.isVisible,
        isLocked: app.isLocked,
        config: app.config ? JSON.parse(app.config) : null,
      },
    });
  } catch (error) {
    console.error('Failed to update app:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update app' },
      { status: 500 }
    );
  }
}

// DELETE /api/workspace/[id]/apps/[wid] - Remove app
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; wid: string }> }
) {
  try {
    const unauthorized = await requireWorkspaceAdmin(request);
    if (unauthorized) return unauthorized;

    const { id: workspaceId, wid: appId } = await params;

    // Verify app exists and belongs to workspace
    const existing = await prisma.workspaceApp.findUnique({
      where: { id: appId },
    });

    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'App not found' },
        { status: 404 }
      );
    }

    if (existing.workspaceId !== workspaceId) {
      return NextResponse.json(
        { success: false, error: 'App does not belong to this workspace' },
        { status: 400 }
      );
    }

    await prisma.workspaceApp.delete({ where: { id: appId } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete app:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete app' },
      { status: 500 }
    );
  }
}
