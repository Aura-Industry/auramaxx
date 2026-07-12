import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { requireWorkspaceAdmin } from '../../auth';

const prisma = new PrismaClient();

// POST /api/workspace/[id]/apps - Add app to workspace
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const unauthorized = await requireWorkspaceAdmin(request);
    if (unauthorized) return unauthorized;

    const { id: workspaceId } = await params;
    const body = await request.json();
    const { appType, x, y, width, height, zIndex, isVisible, isLocked, config } = body;

    if (!appType) {
      return NextResponse.json(
        { success: false, error: 'appType is required' },
        { status: 400 }
      );
    }

    // Verify workspace exists
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) {
      return NextResponse.json(
        { success: false, error: 'Workspace not found' },
        { status: 404 }
      );
    }

    // Get max zIndex for this workspace
    const maxZ = await prisma.workspaceApp.aggregate({
      where: { workspaceId },
      _max: { zIndex: true },
    });
    const newZIndex = zIndex ?? (maxZ._max.zIndex ?? 9) + 1;

    const app = await prisma.workspaceApp.create({
      data: {
        workspaceId,
        appType,
        x: x ?? 20,
        y: y ?? 20,
        width: width ?? 320,
        height: height ?? 280,
        zIndex: newZIndex,
        isVisible: isVisible ?? true,
        isLocked: isLocked ?? false,
        config: config ? JSON.stringify(config) : null,
      },
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
    console.error('Failed to add app:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to add app' },
      { status: 500 }
    );
  }
}
