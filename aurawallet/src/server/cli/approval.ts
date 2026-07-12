/**
 * Terminal Approval Interface
 *
 * Connects to the WebSocket server to receive ACTION_CREATED events
 * and presents an interactive terminal UI for approve/reject decisions.
 */

import * as readline from 'readline';
import { WebSocket } from 'ws';
import { getErrorMessage } from '../lib/error';

interface HumanAction {
  id: string;
  type: string;
  agentId: string;
  limit: number;
  permissions: string[];
  ttl: number;
  createdAt: number;
}

interface ApprovalManagerOptions {
  serverUrl: string;
  getToken: () => string | null;
  autoApprove?: boolean;
  headless?: boolean; // Skip terminal interface (for --password-stdin mode)
}

export class ApprovalManager {
  private ws: WebSocket | null = null;
  private pendingRequests: Map<string, HumanAction> = new Map();
  private rl: readline.Interface | null = null;
  private options: ApprovalManagerOptions;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(options: ApprovalManagerOptions) {
    this.options = options;
  }

  /**
   * Start the approval manager
   */
  async start(): Promise<void> {
    this.isRunning = true;

    // Fetch any existing pending requests
    await this.fetchPendingRequests();

    // Connect to WebSocket
    this.connectWebSocket();

    // Set up terminal interface (skip in headless mode)
    if (!this.options.headless) {
      this.setupTerminalInterface();
    }
  }

  /**
   * Stop the approval manager
   */
  stop(): void {
    this.isRunning = false;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  /**
   * Fetch existing pending requests from the server
   */
  private async fetchPendingRequests(): Promise<void> {
    try {
      const token = this.options.getToken();
      if (!token) return;

      const response = await fetch(`${this.options.serverUrl}/actions/pending`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (response.ok) {
        const data = await response.json() as { success?: boolean; actions?: HumanAction[] };
        const requests = data.actions || [];
        for (const req of requests) {
          this.addRequest(req);
        }
        if (requests.length > 0) {
          console.log(`\nFound ${requests.length} pending request(s).`);
          this.displayQueue();
        }
      }
    } catch {
      // Silently ignore - will get requests via WebSocket
    }
  }

  /**
   * Connect to the WebSocket server
   */
  private connectWebSocket(): void {
    const wsUrl = process.env.WS_URL || 'ws://localhost:4748';

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('WebSocket connected - listening for events');
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleEvent(event);
        } catch {
          // Ignore malformed messages
        }
      });

      this.ws.on('close', () => {
        if (this.isRunning) {
          console.log('WebSocket disconnected, reconnecting in 3s...');
          this.reconnectTimeout = setTimeout(() => {
            this.connectWebSocket();
          }, 3000);
        }
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
      });
    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      if (this.isRunning) {
        this.reconnectTimeout = setTimeout(() => {
          this.connectWebSocket();
        }, 3000);
      }
    }
  }

  /**
   * Handle incoming WebSocket event
   */
  private handleEvent(event: { type: string; data: unknown }): void {
    switch (event.type) {
      case 'action:created':
        this.handleRequestCreated(event.data as HumanAction);
        break;
      case 'action:resolved':
        this.handleRequestResolved((event.data as { id: string }).id);
        break;
    }
  }

  /**
   * Handle new request created
   */
  private handleRequestCreated(request: HumanAction): void {
    this.addRequest(request);

    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│  NEW AGENT REQUEST                                          │');
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│  ID:          ${request.id.substring(0, 40).padEnd(45)}│`);
    console.log(`│  Agent:       ${request.agentId.substring(0, 40).padEnd(45)}│`);
    console.log(`│  Type:        ${request.type.padEnd(45)}│`);
    console.log(`│  Limit:       ${(request.limit + ' ETH').padEnd(45)}│`);
    console.log(`│  Permissions: ${request.permissions.slice(0, 3).join(', ').substring(0, 40).padEnd(45)}│`);
    console.log(`│  TTL:         ${(request.ttl + 's').padEnd(45)}│`);
    console.log('└─────────────────────────────────────────────────────────────┘');

    if (this.options.autoApprove) {
      console.log('Auto-approving (--auto-approve enabled)...');
      this.resolveAction(request.id, true);
    } else {
      console.log('\nEnter request number to review, or:');
      console.log('  a <id> - approve    r <id> - reject    l - list pending\n');
    }
  }

  /**
   * Handle request resolved (approved or rejected)
   */
  private handleRequestResolved(requestId: string): void {
    this.pendingRequests.delete(requestId);
  }

  /**
   * Add request to pending queue
   */
  private addRequest(request: HumanAction): void {
    this.pendingRequests.set(request.id, {
      ...request,
      createdAt: Date.now()
    });
  }

  /**
   * Display the pending request queue
   */
  private displayQueue(): void {
    const requests = Array.from(this.pendingRequests.values());

    if (requests.length === 0) {
      console.log('\nNo pending requests.\n');
      return;
    }

    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│  PENDING REQUESTS                                           │');
    console.log('├─────────────────────────────────────────────────────────────┤');

    requests.forEach((req, index) => {
      const shortId = req.id.substring(0, 8);
      const agent = req.agentId.substring(0, 20).padEnd(20);
      const type = req.type.substring(0, 15).padEnd(15);
      console.log(`│  ${(index + 1).toString().padStart(2)}. [${shortId}] ${agent} ${type} ${req.limit} ETH │`);
    });

    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('\nCommands: a <id> approve, r <id> reject, <num> review, l list\n');
  }

  /**
   * Set up terminal interface for user input
   */
  private setupTerminalInterface(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'aura> '
    });

    this.rl.on('line', (line) => {
      this.handleCommand(line.trim());
      this.rl?.prompt();
    });

    this.rl.on('close', () => {
      // Interface closed
    });

    // Initial prompt
    this.rl.prompt();
  }

  /**
   * Handle user command
   */
  private handleCommand(input: string): void {
    if (!input) return;

    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts[1];

    switch (cmd) {
      case 'l':
      case 'list':
        this.displayQueue();
        break;

      case 'a':
      case 'approve':
        if (arg) {
          this.approveByIdOrNumber(arg);
        } else {
          console.log('Usage: a <id or number>');
        }
        break;

      case 'r':
      case 'reject':
        if (arg) {
          this.rejectByIdOrNumber(arg);
        } else {
          console.log('Usage: r <id or number>');
        }
        break;

      case 'h':
      case 'help':
        this.showHelp();
        break;

      case 'q':
      case 'quit':
        console.log('Use Ctrl+C to exit.');
        break;

      default:
        // Check if it's a number (review by index)
        const num = parseInt(cmd, 10);
        if (!isNaN(num)) {
          this.reviewByNumber(num);
        } else {
          console.log(`Unknown command: ${cmd}. Type 'h' for help.`);
        }
    }
  }

  /**
   * Show help
   */
  private showHelp(): void {
    console.log(`
Commands:
  l, list           List all pending requests
  a, approve <id>   Approve request by ID or number
  r, reject <id>    Reject request by ID or number
  <number>          Review request details by queue number
  h, help           Show this help
  Ctrl+C            Exit CLI
`);
  }

  /**
   * Review request by queue number
   */
  private reviewByNumber(num: number): void {
    const requests = Array.from(this.pendingRequests.values());
    const index = num - 1;

    if (index < 0 || index >= requests.length) {
      console.log(`Invalid number. Use 1-${requests.length}`);
      return;
    }

    const req = requests[index];
    console.log(`
┌─────────────────────────────────────────────────────────────┐
│  REQUEST DETAILS                                            │
├─────────────────────────────────────────────────────────────┤
│  ID:          ${req.id}
│  Agent:       ${req.agentId}
│  Type:        ${req.type}
│  Limit:       ${req.limit} ETH
│  Permissions: ${req.permissions.join(', ')}
│  TTL:         ${req.ttl}s (${Math.round(req.ttl / 60)} minutes)
└─────────────────────────────────────────────────────────────┘

  a ${num}  - approve    r ${num}  - reject
`);
  }

  /**
   * Approve by ID or queue number
   */
  private approveByIdOrNumber(arg: string): void {
    const id = this.resolveRequestId(arg);
    if (id) {
      this.resolveAction(id, true);
    }
  }

  /**
   * Reject by ID or queue number
   */
  private rejectByIdOrNumber(arg: string): void {
    const id = this.resolveRequestId(arg);
    if (id) {
      this.resolveAction(id, false);
    }
  }

  /**
   * Resolve argument to request ID
   */
  private resolveRequestId(arg: string): string | null {
    // Try as number first
    const num = parseInt(arg, 10);
    if (!isNaN(num)) {
      const requests = Array.from(this.pendingRequests.values());
      const index = num - 1;
      if (index >= 0 && index < requests.length) {
        return requests[index].id;
      }
      console.log(`Invalid number. Use 1-${requests.length}`);
      return null;
    }

    // Try as ID (partial match)
    const matching = Array.from(this.pendingRequests.keys()).filter(
      id => id.startsWith(arg) || id.includes(arg)
    );

    if (matching.length === 1) {
      return matching[0];
    } else if (matching.length > 1) {
      console.log('Ambiguous ID, matches:', matching.map(id => id.substring(0, 12)).join(', '));
      return null;
    } else {
      console.log('Request not found:', arg);
      return null;
    }
  }

  /**
   * Resolve an action (approve or reject)
   */
  private async resolveAction(requestId: string, approved: boolean): Promise<void> {
    const token = this.options.getToken();
    if (!token) {
      console.log('Error: No admin token available');
      return;
    }

    try {
      const response = await fetch(`${this.options.serverUrl}/actions/${requestId}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ approved })
      });

      const data = await response.json() as { success?: boolean; error?: string; agentId?: string; token?: string };

      if (response.ok && data.success) {
        if (approved) {
          console.log(`✓ Request approved. Token created for ${data.agentId}`);
        } else {
          console.log(`✓ Request rejected`);
        }
        this.pendingRequests.delete(requestId);
      } else {
        console.log(`✗ Failed to ${approved ? 'approve' : 'reject'}: ${data.error || 'Unknown error'}`);
      }
    } catch (error) {
      const message = getErrorMessage(error);
      console.log(`✗ Error ${approved ? 'approving' : 'rejecting'} request: ${message}`);
    }
  }
}
