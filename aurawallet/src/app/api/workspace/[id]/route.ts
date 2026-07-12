import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { requireWorkspaceAdmin } from '../auth';

const prisma = new PrismaClient();

// GET /api/workspace/[id] - Get workspace with apps
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const unauthorized = await requireWorkspaceAdmin(request);
    if (unauthorized) return unauthorized;

    const { id } = await params;

    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: {
        apps: {
          orderBy: { zIndex: 'asc' },
        },
      },
    });

    if (!workspace) {
      return NextResponse.json(
        { success: false, error: 'Workspace not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        icon: workspace.icon,
        order: workspace.order,
        isDefault: workspace.isDefault,
        isCloseable: workspace.isCloseable,
      },
      apps: workspace.apps.map((w: any) => ({
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
        config: w.config ? JSON.parse(w.config) : null,
      })),
    });
  } catch (error) {
    console.error('Failed to get workspace:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to get workspace' },
      { status: 500 }
    );
  }
}

// PATCH /api/workspace/[id] - Update workspace
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const unauthorized = await requireWorkspaceAdmin(request);
    if (unauthorized) return unauthorized;

    const { id } = await params;
    const body = await request.json();
    const { name, icon, order, isDefault, isCloseable } = body;

    // Check if workspace exists
    const existing = await prisma.workspace.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'Workspace not found' },
        { status: 404 }
      );
    }

    // If setting as default, unset existing default
    if (isDefault) {
      await prisma.workspace.updateMany({
        where: { isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }

    const workspace = await prisma.workspace.update({
      where: { id },
      data: {
        name: name ?? existing.name,
        icon: icon ?? existing.icon,
        order: order ?? existing.order,
        isDefault: isDefault ?? existing.isDefault,
        isCloseable: isCloseable ?? existing.isCloseable,
      },
    });

    return NextResponse.json({
      success: true,
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        icon: workspace.icon,
        order: workspace.order,
        isDefault: workspace.isDefault,
        isCloseable: workspace.isCloseable,
      },
    });
  } catch (error) {
    console.error('Failed to update workspace:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update workspace' },
      { status: 500 }
    );
  }
}

// DELETE /api/workspace/[id] - Delete workspace
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const unauthorized = await requireWorkspaceAdmin(request);
    if (unauthorized) return unauthorized;

    const { id } = await params;

    // Check if workspace exists and is closeable
    const workspace = await prisma.workspace.findUnique({ where: { id } });
    if (!workspace) {
      return NextResponse.json(
        { success: false, error: 'Workspace not found' },
        { status: 404 }
      );
    }

    if (!workspace.isCloseable) {
      return NextResponse.json(
        { success: false, error: 'Cannot delete non-closeable workspace' },
        { status: 400 }
      );
    }

    // Cascade delete will remove apps
    await prisma.workspace.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete workspace:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to delete workspace' },
      { status: 500 }
    );
  }
}
