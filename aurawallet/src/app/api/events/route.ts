import { NextRequest, NextResponse } from 'next/server';
import { broadcast } from '@/lib/websocket-server';
import { prisma } from '@/lib/db';
import type { WalletEvent } from '@/lib/events';

/**
 * GET /api/events
 * Query events from database with optional filtering
 * No authentication required
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type');
    const category = searchParams.get('category');
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 250);
    const offset = parseInt(searchParams.get('offset') || '0');

    // Build where clause
    const where: Record<string, unknown> = {};
    if (type) {
      where.type = type;
    } else if (category) {
      where.type = { startsWith: `${category}:` };
    }

    // Query events
    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.event.count({ where }),
    ]);

    return NextResponse.json({
      success: true,
      events: events.map((e: any) => ({
        ...e,
        data: typeof e.data === 'string' ? JSON.parse(e.data) : e.data,
      })),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + events.length < total,
      },
    });
  } catch (error) {
    console.error('[Events] Error fetching events:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch events' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/events
 * Webhook endpoint to receive events from Express server
 * and broadcast them to WebSocket clients
 */
export async function POST(request: NextRequest) {
  try {
    const event: WalletEvent = await request.json();

    // Validate event structure
    if (!event.type || !event.timestamp || !event.data) {
      return NextResponse.json(
        { error: 'Invalid event structure' },
        { status: 400 }
      );
    }

    // Broadcast to all connected WebSocket clients
    broadcast(event);

    return NextResponse.json({
      success: true,
      type: event.type,
      clientsNotified: true,
    });
  } catch (error) {
    console.error('[Events] Error processing webhook:', error);
    return NextResponse.json(
      { error: 'Failed to process event' },
      { status: 500 }
    );
  }
}
