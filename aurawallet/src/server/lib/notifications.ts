import { prisma } from './db';
import { loadConfig } from './config';

interface NotificationAction {
  id: string;
  label: string;
  type: 'primary' | 'secondary' | 'danger' | 'link';
  action: 'api' | 'navigate' | 'dismiss';
  endpoint?: string;
  method?: string;
  body?: Record<string, unknown>;
  href?: string;
  external?: boolean;
}

interface CreateNotificationParams {
  type: 'pending_approval' | 'info' | 'warning' | 'success' | 'error' | 'system';
  category?: 'transaction' | 'security' | 'token' | 'wallet' | 'general' | 'social';
  title: string;
  message: string;
  actions?: NotificationAction[];
  metadata?: Record<string, unknown>;
  humanActionId?: string;
  hash?: string;
  expiresAt?: Date;
  source?: 'system' | 'agent' | 'user';
  agentId?: string;
}

export async function createNotification(params: CreateNotificationParams) {
  // If hash is provided, skip if notification with this hash already exists (dedup)
  if (params.hash) {
    const existing = await prisma.notification.findUnique({
      where: { hash: params.hash },
      select: { id: true },
    });
    if (existing) return null;
  }

  return prisma.notification.create({
    data: {
      type: params.type,
      category: params.category,
      title: params.title,
      message: params.message,
      actions: params.actions ? JSON.stringify(params.actions) : null,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
      humanActionId: params.humanActionId,
      hash: params.hash,
      expiresAt: params.expiresAt,
      source: params.source || 'system',
      agentId: params.agentId,
    },
  });
}

export async function createHumanActionNotification(request: {
  id: string;
  type: string;
  fromTier: string;
  toAddress: string | null;
  amount: string | null;
  chain: string;
  metadata?: string | null;
}) {
  const config = loadConfig();
  const explorer = config.chains[request.chain]?.explorer || 'https://basescan.org';

  const typeLabels: Record<string, string> = {
    fund: 'Fund Request',
    send: 'Send Request',
    agent_access: 'Agent Access Request',
    auth: 'Agent Auth Request',
    action: 'Action Request',
    notify: 'Token Alert',
  };

  const title = typeLabels[request.type] || 'Pending Request';
  const shortAddr = request.toAddress
    ? `${request.toAddress.slice(0, 6)}...${request.toAddress.slice(-4)}`
    : 'Unknown';

  let message: string;
  if (request.type === 'agent_access' || request.type === 'auth') {
    // Parse metadata to get agent info
    let agentId = 'Unknown Agent';
    let limit = 0;
    let requestedLimitExplicit = false;
    let summary = '';
    if (request.metadata) {
      try {
        const meta = JSON.parse(request.metadata);
        agentId = meta.agentId || agentId;
        if (typeof meta.limit === 'number') limit = meta.limit;
        if (typeof meta?.limits?.fund === 'number') limit = meta.limits.fund;
        requestedLimitExplicit = meta.requestedLimitExplicit === true;
        if (typeof meta.summary === 'string') summary = meta.summary;
      } catch {
        // ignore
      }
    }
    if (summary) {
      message = summary;
    } else if (requestedLimitExplicit) {
      message = `${agentId} requesting ${limit} ETH access`;
    } else {
      message = `${agentId} requesting access`;
    }
  } else if (request.type === 'action') {
    let summary = 'Action pending';
    let callerAgentId = 'app';
    if (request.metadata) {
      try {
        const meta = JSON.parse(request.metadata);
        const vs = meta.verifiedSummary;
        summary = vs?.oneLiner || meta.summary || summary;
        callerAgentId = meta.agentId || callerAgentId;
      } catch {}
    }
    message = `${callerAgentId}: ${summary}`;
  } else if (request.amount) {
    message = `${request.amount} ETH to ${shortAddr}`;
  } else {
    message = `Request to ${shortAddr}`;
  }

  const actions: NotificationAction[] = [
    {
      id: 'approve',
      label: 'APPROVE',
      type: 'primary',
      action: 'api',
      endpoint: `/actions/${request.id}/resolve`,
      method: 'POST',
      body: { approved: true },
    },
    {
      id: 'reject',
      label: 'REJECT',
      type: 'danger',
      action: 'api',
      endpoint: `/actions/${request.id}/resolve`,
      method: 'POST',
      body: { approved: false },
    },
  ];

  const metadata: Record<string, unknown> = {
    requestType: request.type,
    fromTier: request.fromTier,
    toAddress: request.toAddress,
    amount: request.amount,
    chain: request.chain,
    explorer,
  };

  if (request.metadata) {
    try {
      const parsed = JSON.parse(request.metadata);
      Object.assign(metadata, parsed);
    } catch {
      // ignore parse errors
    }
  }

  return createNotification({
    type: 'pending_approval',
    category: 'transaction',
    title,
    message,
    actions,
    metadata,
    humanActionId: request.id,
    source: 'system',
  });
}

export async function resolveNotificationForRequest(
  requestId: string,
  resolution: 'approved' | 'rejected',
  resultData?: { txHash?: string; explorer?: string }
) {
  // Find and dismiss the pending notification
  const notification = await prisma.notification.findFirst({
    where: { humanActionId: requestId },
  });

  if (notification) {
    await prisma.notification.update({
      where: { id: notification.id },
      data: { dismissed: true, read: true },
    });
  }

  // Create a success/info notification about the resolution
  if (resolution === 'approved' && resultData?.txHash) {
    const actions: NotificationAction[] = [];
    if (resultData.explorer) {
      actions.push({
        id: 'view_tx',
        label: 'VIEW TX',
        type: 'link',
        action: 'navigate',
        href: `${resultData.explorer}/tx/${resultData.txHash}`,
        external: true,
      });
    }
    actions.push({
      id: 'dismiss',
      label: 'DISMISS',
      type: 'secondary',
      action: 'dismiss',
    });

    await createNotification({
      type: 'success',
      category: 'transaction',
      title: 'Transaction Approved',
      message: `TX: ${resultData.txHash.slice(0, 10)}...${resultData.txHash.slice(-6)}`,
      actions,
      metadata: { txHash: resultData.txHash, explorer: resultData.explorer },
      source: 'system',
    });
  } else if (resolution === 'rejected') {
    await createNotification({
      type: 'info',
      category: 'transaction',
      title: 'Request Rejected',
      message: 'The pending request was rejected.',
      actions: [
        {
          id: 'dismiss',
          label: 'DISMISS',
          type: 'secondary',
          action: 'dismiss',
        },
      ],
      source: 'system',
    });
  }
}
