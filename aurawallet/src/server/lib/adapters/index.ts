/**
 * Public exports for the approval adapter system.
 */

export { ApprovalRouter } from './router';
export { createAdapters, registerAdapterType, loadAdaptersFromDb } from './factory';
export type {
  ApprovalAdapter,
  AdapterContext,
  ActionNotification,
  ActionResolution,
  ResolveOptions,
  ResolveResult,
  AdapterFactory,
  ChatMessage,
  ChatReply,
} from './types';
export { WebhookAdapter, type WebhookAdapterConfig } from './webhook';
export { TelegramAdapter, type TelegramAdapterConfig } from './telegram';
export { WhatsAppAdapter, type WhatsAppAdapterConfig } from './whatsapp';
export { DiscordAdapter, type DiscordAdapterConfig } from './discord';
