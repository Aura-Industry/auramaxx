import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// GET /api/apps/static/[...path] - Serve static files from apps/ directory
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: segments } = await params;
    const relativePath = segments.join('/');

    // Security: prevent path traversal
    if (relativePath.includes('..') || relativePath.includes('\0')) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    const appsDir = path.join(process.cwd(), 'apps');
    const filePath = path.join(appsDir, relativePath);

    // Ensure resolved path is within apps/
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(appsDir))) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);

    return new NextResponse(content, {
      headers: { 'Content-Type': contentType },
    });
  } catch (error) {
    console.error('Failed to serve app static file:', error);
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
