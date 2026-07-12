import { NextRequest, NextResponse } from 'next/server';
import {
  authorizeAdapterManage,
  importOpenClawChannel,
  resolveOpenClawSource,
} from '../lib';

export const runtime = 'nodejs';

interface ImportChannelRequestBody {
  openclawConfigPath?: string;
  chatEnabled?: boolean;
}

// POST /api/import-from-openclaw/[channel] - Import one channel
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ channel: string }> },
) {
  const auth = await authorizeAdapterManage(request);
  if (auth.ok === false) return auth.response;
  const token = auth.token;

  try {
    const { channel } = await params;
    let body: ImportChannelRequestBody = {};
    try {
      body = await request.json() as ImportChannelRequestBody;
    } catch {
      // Optional body; treat parse failures as empty body.
    }

    const source = await resolveOpenClawSource(body.openclawConfigPath);
    const result = await importOpenClawChannel(source, channel, token, { chatEnabled: body.chatEnabled });

    if (!result.validation.exists) {
      return NextResponse.json(
        {
          success: false,
          configPath: source.configPath,
          ...result,
        },
        { status: 404 },
      );
    }

    return NextResponse.json(
      {
        success: result.imported,
        configPath: source.configPath,
        ...result,
      },
      { status: result.imported ? 200 : 400 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to import channel from OpenClaw';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
