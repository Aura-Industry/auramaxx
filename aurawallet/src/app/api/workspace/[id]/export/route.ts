import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { requireWorkspaceAdmin } from '../../auth';

const prisma = new PrismaClient();

// GET /api/workspace/[id]/export - Export workspace as JSON
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
        apps: true,
      },
    });

    if (!workspace) {
      return NextResponse.json(
        { success: false, error: 'Workspace not found' },
        { status: 404 }
      );
    }

    const exportData = {
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: {
        name: workspace.name,
        slug: workspace.slug,
        icon: workspace.icon,
        order: workspace.order,
        isDefault: workspace.isDefault,
        isCloseable: workspace.isCloseable,
      },
      apps: workspace.apps.map((w: any) => ({
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
    };

    return NextResponse.json({
      success: true,
      data: exportData,
    });
  } catch (error) {
    console.error('Failed to export workspace:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to export workspace' },
      { status: 500 }
    );
  }
}
