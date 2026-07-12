import { NextRequest, NextResponse } from 'next/server';
import {
  authorizeAdapterManage,
  importOpenClawChannel,
  resolveOpenClawSource,
} from './lib';

export const runtime = 'nodejs';

interface ImportAllRequestBody {
  openclawConfigPath?: string;
  channels?: string[];
  chatEnabled?: boolean;
}

function toRequestedChannels(rawChannels: unknown, discovered: string[]): string[] {
  if (!Array.isArray(rawChannels)) {
    return discovered;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of rawChannels) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

// POST /api/import-from-openclaw - Import all channels (or selected channels)
export async function POST(request: NextRequest) {
  const auth = await authorizeAdapterManage(request);
  if (auth.ok === false) return auth.response;
  const token = auth.token;

  try {
    let body: ImportAllRequestBody = {};
    try {
      body = await request.json() as ImportAllRequestBody;
    } catch {
      // Optional body; treat parse failures as empty body.
    }

    const source = await resolveOpenClawSource(body.openclawConfigPath);
    const discoveredChannels = Object.keys(source.channels);
    const requestedChannels = toRequestedChannels(body.channels, discoveredChannels);

    if (requestedChannels.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: `No channels found in ${source.configPath}`,
          configPath: source.configPath,
        },
        { status: 400 },
      );
    }

    const results = [];
    for (const channel of requestedChannels) {
      // Sequential on purpose: deterministic updates and easier error reporting.
      results.push(await importOpenClawChannel(source, channel, token, { chatEnabled: body.chatEnabled }));
    }

    const importedCount = results.filter((result) => result.imported).length;
    const failedCount = results.length - importedCount;

    return NextResponse.json({
      success: failedCount === 0,
      partial: importedCount > 0 && failedCount > 0,
      configPath: source.configPath,
      requestedChannels,
      importedCount,
      failedCount,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to import from OpenClaw';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
