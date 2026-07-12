import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { requireWorkspaceAdmin } from '../auth';

const prisma = new PrismaClient();

interface ImportApp {
  appType: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  zIndex?: number;
  isVisible?: boolean;
  isLocked?: boolean;
  config?: Record<string, unknown>;
}

interface ImportData {
  version?: number;
  workspace: {
    name: string;
    slug?: string;
    icon?: string;
    order?: number;
    isDefault?: boolean;
    isCloseable?: boolean;
  };
  apps: ImportApp[];
}

// POST /api/workspace/import - Import workspace from JSON
export async function POST(request: NextRequest) {
  try {
    const unauthorized = await requireWorkspaceAdmin(request);
    if (unauthorized) return unauthorized;

    const body: ImportData = await request.json();
    const { workspace: wsData, apps } = body;

    if (!wsData || !wsData.name) {
      return NextResponse.json(
        { success: false, error: 'Invalid import data: workspace name is required' },
        { status: 400 }
      );
    }

    // Generate unique slug
    const baseSlug = wsData.slug || wsData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    let slug = baseSlug;
    let counter = 1;

    while (await prisma.workspace.findUnique({ where: { slug } })) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    // Get next order value
    const maxOrder = await prisma.workspace.aggregate({
      _max: { order: true },
    });
    const order = wsData.order ?? (maxOrder._max.order ?? -1) + 1;

    // Create workspace
    const workspace = await prisma.workspace.create({
      data: {
        name: wsData.name,
        slug,
        icon: wsData.icon,
        order,
        isDefault: wsData.isDefault ?? false,
        isCloseable: wsData.isCloseable ?? true,
      },
    });

    // Create apps
    const createdApps = [];
    for (const app of apps || []) {
      const created = await prisma.workspaceApp.create({
        data: {
          workspaceId: workspace.id,
          appType: app.appType,
          x: app.x ?? 20,
          y: app.y ?? 20,
          width: app.width ?? 320,
          height: app.height ?? 280,
          zIndex: app.zIndex ?? 10,
          isVisible: app.isVisible ?? true,
          isLocked: app.isLocked ?? false,
          config: app.config ? JSON.stringify(app.config) : null,
        },
      });
      createdApps.push({
        id: created.id,
        appType: created.appType,
        x: created.x,
        y: created.y,
        width: created.width,
        height: created.height,
        zIndex: created.zIndex,
        isVisible: created.isVisible,
        isLocked: created.isLocked,
        config: created.config ? JSON.parse(created.config) : null,
      });
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
      apps: createdApps,
    });
  } catch (error) {
    console.error('Failed to import workspace:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to import workspace' },
      { status: 500 }
    );
  }
}
