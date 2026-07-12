import { NextResponse } from 'next/server';
import { loadAppManifests } from '@/lib/app-loader';

// GET /api/apps/manifests - Return all loaded app manifests
export async function GET() {
  try {
    const manifests = loadAppManifests();
    return NextResponse.json({ success: true, manifests });
  } catch (error) {
    console.error('Failed to load app manifests:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to load app manifests' },
      { status: 500 }
    );
  }
}
