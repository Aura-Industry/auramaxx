import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { requireWorkspaceAdmin } from './auth';

const prisma = new PrismaClient();

// GET /api/workspace - List all workspaces
export async function GET(request: NextRequest) {
  try {
    const unauthorized = await requireWorkspaceAdmin(request);
    if (unauthorized) return unauthorized;

    const workspaces = await prisma.workspace.findMany({
      orderBy: { order: 'asc' },
      include: {
        _count: {
          select: { apps: true },
        },
      },
    });

    return NextResponse.json({
      success: true,
      workspaces: workspaces.map((w: any) => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        icon: w.icon,
        order: w.order,
        isDefault: w.isDefault,
        isCloseable: w.isCloseable,
        appCount: w._count.apps,
        createdAt: w.createdAt.toISOString(),
        updatedAt: w.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('Failed to list workspaces:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to list workspaces' },
      { status: 500 }
    );
  }
}

// POST /api/workspace - Create a new workspace
export async function POST(request: NextRequest) {
  try {
    const unauthorized = await requireWorkspaceAdmin(request);
    if (unauthorized) return unauthorized;

    const body = await request.json();
    const { name, icon, isDefault } = body;

    if (!name) {
      return NextResponse.json(
        { success: false, error: 'Name is required' },
        { status: 400 }
      );
    }

    // Generate unique slug
    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
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
    const order = (maxOrder._max.order ?? -1) + 1;

    // If setting as default, unset existing default
    if (isDefault) {
      await prisma.workspace.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }

    const workspace = await prisma.workspace.create({
      data: {
        name,
        slug,
        icon,
        order,
        isDefault: isDefault ?? false,
        isCloseable: true,
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
    console.error('Failed to create workspace:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to create workspace' },
      { status: 500 }
    );
  }
}
