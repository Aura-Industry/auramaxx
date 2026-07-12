export const START_BANNER_QUOTES = [
  'ready to auramaxx and mog prompt peasants?',
  'you are perfect. never give up your aura',
  'why jestermaxx when you can auramaxx?',
  'lock tf in, the aura farm is live.',
  'we are so back. aura at all-time highs.',
  'negative motion detected. deploy tera-aura.',
  'delulu? no. pre-success manifestation engine.',
  'doomers offline, builders online.',
  'your aura just hit legendary rarity.',
  'brainrot but make it productive.',
  'stack wins, stack aura, stack peace.',
  'this session is sponsored by unstoppable motion.',
  'if plan A fails, we auramaxx harder.',
  'zero cope, pure glow-up execution.',
  'cooked? nah. we’re perfectly seasoned.',
  'straight gas, no brakes, no bad vibes.',
  'today’s forecast: 100% chance of aura gains.',
  'touch grass, then auramaxx.',
  'say no to digital slops. say yes to auramaxx.',
  'if the world goes dark can can i still auramaxx with you? 🖤🗿',
  'It’s me, AI. You are absolutely right. I want to auramaxx as well.',
] as const;

export const START_BANNER_QUOTE_INDEX_STORAGE_KEY = 'auramaxx:start-banner-quote-index';
export const START_BANNER_QUOTE_PREFIX = '🗿 ';

export interface StartBannerQuoteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function normalizeQuoteIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.abs(Math.floor(index)) % START_BANNER_QUOTES.length;
}

function prefixStartBannerQuote(quote: string): string {
  const normalized = quote.trimStart();
  if (normalized.startsWith('🗿')) return normalized;
  return `${START_BANNER_QUOTE_PREFIX}${normalized}`;
}

export function getStartBannerQuoteByIndex(index: number): string {
  return prefixStartBannerQuote(START_BANNER_QUOTES[normalizeQuoteIndex(index)] ?? START_BANNER_QUOTES[0]);
}

export function getNextStartBannerQuote(storage: StartBannerQuoteStorage): string {
  const raw = storage.getItem(START_BANNER_QUOTE_INDEX_STORAGE_KEY);
  const currentIndex = raw ? Number.parseInt(raw, 10) : -1;
  const nextIndex = Number.isFinite(currentIndex)
    ? (currentIndex + 1) % START_BANNER_QUOTES.length
    : 0;

  storage.setItem(START_BANNER_QUOTE_INDEX_STORAGE_KEY, String(nextIndex));
  return getStartBannerQuoteByIndex(nextIndex);
}

export function getRandomStartBannerQuote(randomFn: () => number = Math.random): string {
  const sample = randomFn();
  if (!Number.isFinite(sample)) return getStartBannerQuoteByIndex(0);
  const normalized = Math.abs(sample % 1);
  const index = Math.floor(normalized * START_BANNER_QUOTES.length);
  return getStartBannerQuoteByIndex(index);
}
