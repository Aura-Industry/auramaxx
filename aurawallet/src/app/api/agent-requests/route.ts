import { NextResponse } from 'next/server';

const EXPRESS_URL = process.env.WALLET_SERVER_URL || 'http://localhost:4242';

/**
 * GET /api/agent-requests
 * Proxy to Express /dashboard endpoint for agent actions and tokens
 * No authentication required - returns pending actions, recent history, and tokens
 */
export async function GET() {
  try {
    const response = await fetch(`${EXPRESS_URL}/dashboard`);
    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: data.error || 'Failed to fetch agent requests' },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('[AgentDashboard] Error fetching from Express:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch agent requests' },
      { status: 500 }
    );
  }
}
