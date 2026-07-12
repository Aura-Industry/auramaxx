import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { requireWorkspaceAdmin } from '../auth';

const prisma = new PrismaClient();

type ParsedChainConfig = AppConfigData & Record<string, ChainConfig>;

function parseChainConfig(raw?: string | null): ParsedChainConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
  } catch (error) {
    console.warn('Invalid AppConfig.chainConfig JSON, falling back to empty overrides:', error);
  }
  return {};
}

export interface ChainConfig {
  rpc: string;
  chainId: number;
  explorer: string;
}

export interface AppConfigData {
  chainOverrides?: Record<string, ChainConfig>;
}

// GET /api/workspace/config - Get global app configuration
export async function GET(request: NextRequest) {
  try {
    const unauthorized = await requireWorkspaceAdmin(request);
    if (unauthorized) return unauthorized;

    const config = await prisma.appConfig.findUnique({
      where: { id: 'global' },
    });

    if (!config) {
      return NextResponse.json({
        success: true,
        config: { chainOverrides: {} },
      });
    }

    const chainConfig = parseChainConfig(config.chainConfig);

    return NextResponse.json({
      success: true,
      config: {
        // Handle both old format (direct overrides) and new format (nested)
        chainOverrides: chainConfig.chainOverrides || chainConfig,
      },
    });
  } catch (error) {
    console.error('Failed to get app config:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to get app config' },
      { status: 500 }
    );
  }
}

// POST /api/workspace/config - Update global app configuration
export async function POST(request: NextRequest) {
  try {
    const unauthorized = await requireWorkspaceAdmin(request);
    if (unauthorized) return unauthorized;

    const body = await request.json();
    const { chainOverrides } = body as AppConfigData;

    // Validate chain overrides if provided
    if (chainOverrides) {
      for (const [chain, config] of Object.entries(chainOverrides)) {
        if (!config.rpc || typeof config.rpc !== 'string') {
          return NextResponse.json(
            { success: false, error: `Invalid RPC for chain ${chain}` },
            { status: 400 }
          );
        }
        if (!config.chainId || typeof config.chainId !== 'number') {
          return NextResponse.json(
            { success: false, error: `Invalid chainId for chain ${chain}` },
            { status: 400 }
          );
        }
      }
    }

    // Upsert the global config
    const updated = await prisma.appConfig.upsert({
      where: { id: 'global' },
      create: {
        id: 'global',
        chainConfig: JSON.stringify(chainOverrides || {}),
      },
      update: {
        chainConfig: JSON.stringify(chainOverrides || {}),
      },
    });

    const parsedConfig = parseChainConfig(updated.chainConfig ?? undefined);

    return NextResponse.json({
      success: true,
      config: {
        chainOverrides: parsedConfig,
      },
    });
  } catch (error) {
    console.error('Failed to update app config:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to update app config' },
      { status: 500 }
    );
  }
}
