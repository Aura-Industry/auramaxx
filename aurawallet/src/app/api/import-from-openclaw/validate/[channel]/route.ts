import { NextRequest, NextResponse } from 'next/server';
import {
  authorizeAdapterManage,
  resolveOpenClawSource,
  validateOpenClawChannel,
} from '../../lib';

export const runtime = 'nodejs';

interface ValidateChannelRequestBody {
  openclawConfigPath?: string;
}

function resolveConfigPathOverride(request: NextRequest): string | undefined {
  const fromQuery = request.nextUrl.searchParams.get('openclawConfigPath')
    || request.nextUrl.searchParams.get('configPath');
  if (fromQuery && fromQuery.trim()) {
    return fromQuery.trim();
  }
  return undefined;
}

// GET /api/import-from-openclaw/validate/[channel] - Validate one channel in OpenClaw config
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ channel: string }> },
) {
  const auth = await authorizeAdapterManage(request);
  if (auth.ok === false) return auth.response;

  try {
    const { channel } = await params;
    const source = await resolveOpenClawSource(resolveConfigPathOverride(request));
    const validation = await validateOpenClawChannel(source, channel);

    return NextResponse.json(
      {
        success: validation.valid,
        configPath: source.configPath,
        validation,
      },
      { status: validation.exists ? 200 : 404 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to validate channel';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}

// POST /api/import-from-openclaw/validate/[channel] - Validate with optional JSON body override
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channel: string }> },
) {
  const auth = await authorizeAdapterManage(request);
  if (auth.ok === false) return auth.response;

  try {
    const { channel } = await params;
    let body: ValidateChannelRequestBody = {};
    try {
      body = await request.json() as ValidateChannelRequestBody;
    } catch {
      // Optional body; treat parse failures as empty body.
    }

    const source = await resolveOpenClawSource(body.openclawConfigPath || resolveConfigPathOverride(request));
    const validation = await validateOpenClawChannel(source, channel);

    return NextResponse.json(
      {
        success: validation.valid,
        configPath: source.configPath,
        validation,
      },
      { status: validation.exists ? 200 : 404 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to validate channel';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
