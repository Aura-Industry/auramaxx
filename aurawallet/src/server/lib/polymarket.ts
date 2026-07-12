/**
 * Polymarket market scanner helpers.
 *
 * The current scanner looks for binary "complete set" opportunities:
 * buying one share of each outcome for less than $1.00 using the top ask
 * on each side of the CLOB order book.
 */

const GAMMA_MARKETS_URL = 'https://gamma-api.polymarket.com/markets';
const CLOB_BOOK_URL = 'https://clob.polymarket.com/book';
const FETCH_TIMEOUT_MS = 10_000;

interface RawPolymarketMarket {
  id?: string | number;
  question?: string;
  slug?: string;
  active?: boolean;
  closed?: boolean;
  endDate?: string | null;
  icon?: string | null;
  liquidity?: string | number | null;
  liquidityNum?: string | number | null;
  volume?: string | number | null;
  volume24hr?: string | number | null;
  volume24hrClob?: string | number | null;
  outcomes?: string | string[] | null;
  outcomePrices?: string | string[] | null;
  clobTokenIds?: string | string[] | null;
}

interface RawOrderLevel {
  price?: string | number | null;
  size?: string | number | null;
}

interface RawBookResponse {
  asset_id?: string;
  asks?: RawOrderLevel[] | null;
}

export interface PolymarketScannerOptions {
  marketLimit: number;
  bookScanLimit: number;
  minLiquidityUsd: number;
  maxDaysToExpiry: number;
  minGrossEdgePct: number;
  minTopBookShares: number;
  maxCandidates: number;
}

export interface PolymarketScannerLeg {
  outcome: string;
  tokenId: string;
  bestAskPrice: number;
  bestAskSize: number;
}

export interface PolymarketScannerCandidate {
  marketId: string;
  question: string;
  slug: string;
  icon: string | null;
  endDate: string | null;
  liquidityUsd: number;
  volume24hUsd: number;
  completeSetCost: number;
  grossEdgePct: number;
  maxPairShares: number;
  maxGrossProfitUsd: number;
  rationale: string;
  legs: [PolymarketScannerLeg, PolymarketScannerLeg];
}

export interface PolymarketScannerResult {
  scannedAt: string;
  marketCount: number;
  evaluatedCount: number;
  candidateCount: number;
  candidates: PolymarketScannerCandidate[];
}

interface NormalizedPolymarketMarket {
  id: string;
  question: string;
  slug: string;
  icon: string | null;
  endDate: string | null;
  liquidityUsd: number;
  volume24hUsd: number;
  outcomes: [string, string];
  tokenIds: [string, string];
}

interface BestAsk {
  price: number;
  size: number;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (item == null ? '' : String(item).trim()))
      .filter(Boolean);
  }

  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (item == null ? '' : String(item).trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseEndDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function pickVolume24h(raw: RawPolymarketMarket): number {
  return Math.max(
    toFiniteNumber(raw.volume24hr) ?? 0,
    toFiniteNumber(raw.volume24hrClob) ?? 0,
  );
}

function normalizeMarket(raw: RawPolymarketMarket): NormalizedPolymarketMarket | null {
  if (!raw.active || raw.closed) return null;
  if (!raw.question || !raw.slug) return null;

  const outcomes = parseStringArray(raw.outcomes);
  const tokenIds = parseStringArray(raw.clobTokenIds);
  if (outcomes.length !== 2 || tokenIds.length !== 2) return null;

  const liquidityUsd =
    toFiniteNumber(raw.liquidityNum) ??
    toFiniteNumber(raw.liquidity) ??
    0;

  return {
    id: raw.id == null ? raw.slug : String(raw.id),
    question: raw.question.trim(),
    slug: raw.slug.trim(),
    icon: raw.icon ?? null,
    endDate: parseEndDate(raw.endDate),
    liquidityUsd,
    volume24hUsd: pickVolume24h(raw),
    outcomes: [outcomes[0], outcomes[1]],
    tokenIds: [tokenIds[0], tokenIds[1]],
  };
}

function withinExpiryWindow(endDate: string | null, maxDaysToExpiry: number): boolean {
  if (!endDate) return true;

  const now = Date.now();
  const expiresAt = Date.parse(endDate);
  if (Number.isNaN(expiresAt)) return true;
  if (expiresAt <= now) return false;

  const maxMs = maxDaysToExpiry * 24 * 60 * 60 * 1000;
  return expiresAt - now <= maxMs;
}

function pickBestAsk(book: RawBookResponse): BestAsk | null {
  const asks = Array.isArray(book.asks) ? book.asks : [];
  const normalized = asks
    .map((ask) => ({
      price: toFiniteNumber(ask.price),
      size: toFiniteNumber(ask.size),
    }))
    .filter(
      (ask): ask is { price: number; size: number } =>
        ask.price != null &&
        ask.size != null &&
        ask.price > 0 &&
        ask.price < 1 &&
        ask.size > 0,
    )
    .sort((left, right) => left.price - right.price);

  if (normalized.length === 0) return null;

  return normalized[0];
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'AuraWallet Polymarket Scanner',
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.json() as Promise<T>;
}

async function fetchActiveBinaryMarkets(
  options: PolymarketScannerOptions,
): Promise<NormalizedPolymarketMarket[]> {
  const params = new URLSearchParams({
    active: 'true',
    closed: 'false',
    limit: String(options.marketLimit),
  });
  const url = `${GAMMA_MARKETS_URL}?${params.toString()}`;
  const rawMarkets = await fetchJson<RawPolymarketMarket[]>(url);

  return rawMarkets
    .map(normalizeMarket)
    .filter((market): market is NormalizedPolymarketMarket => market !== null)
    .filter((market) => market.liquidityUsd >= options.minLiquidityUsd)
    .filter((market) => withinExpiryWindow(market.endDate, options.maxDaysToExpiry))
    .sort((left, right) => right.liquidityUsd - left.liquidityUsd);
}

async function fetchBestAsk(tokenId: string): Promise<BestAsk | null> {
  const url = `${CLOB_BOOK_URL}?token_id=${encodeURIComponent(tokenId)}`;
  const book = await fetchJson<RawBookResponse>(url);
  return pickBestAsk(book);
}

function buildCandidate(
  market: NormalizedPolymarketMarket,
  legs: [BestAsk, BestAsk],
): PolymarketScannerCandidate {
  const completeSetCost = legs[0].price + legs[1].price;
  const grossEdgePct = Number(((1 - completeSetCost) * 100).toFixed(4));
  const maxPairShares = Number(Math.min(legs[0].size, legs[1].size).toFixed(4));
  const maxGrossProfitUsd = Number(
    (maxPairShares * (1 - completeSetCost)).toFixed(4),
  );

  return {
    marketId: market.id,
    question: market.question,
    slug: market.slug,
    icon: market.icon,
    endDate: market.endDate,
    liquidityUsd: Number(market.liquidityUsd.toFixed(2)),
    volume24hUsd: Number(market.volume24hUsd.toFixed(2)),
    completeSetCost: Number(completeSetCost.toFixed(4)),
    grossEdgePct,
    maxPairShares,
    maxGrossProfitUsd,
    rationale:
      `Buy one share of each outcome at the current best ask. ` +
      `${market.outcomes[0]} @ ${legs[0].price.toFixed(4)} + ` +
      `${market.outcomes[1]} @ ${legs[1].price.toFixed(4)} = ` +
      `${completeSetCost.toFixed(4)} total cost.`,
    legs: [
      {
        outcome: market.outcomes[0],
        tokenId: market.tokenIds[0],
        bestAskPrice: Number(legs[0].price.toFixed(4)),
        bestAskSize: Number(legs[0].size.toFixed(4)),
      },
      {
        outcome: market.outcomes[1],
        tokenId: market.tokenIds[1],
        bestAskPrice: Number(legs[1].price.toFixed(4)),
        bestAskSize: Number(legs[1].size.toFixed(4)),
      },
    ],
  };
}

export async function scanPolymarketCompleteSets(
  options: PolymarketScannerOptions,
): Promise<PolymarketScannerResult> {
  const markets = await fetchActiveBinaryMarkets(options);
  const marketsToEvaluate = markets.slice(0, options.bookScanLimit);

  const candidateResults = await Promise.all(
    marketsToEvaluate.map(async (market) => {
      const [leftAsk, rightAsk] = await Promise.all([
        fetchBestAsk(market.tokenIds[0]),
        fetchBestAsk(market.tokenIds[1]),
      ]);

      if (!leftAsk || !rightAsk) return null;

      const completeSetCost = leftAsk.price + rightAsk.price;
      const grossEdgePct = (1 - completeSetCost) * 100;
      const maxPairShares = Math.min(leftAsk.size, rightAsk.size);

      if (grossEdgePct < options.minGrossEdgePct) return null;
      if (maxPairShares < options.minTopBookShares) return null;

      return buildCandidate(market, [leftAsk, rightAsk]);
    }),
  );

  const candidates = candidateResults
    .filter((candidate): candidate is PolymarketScannerCandidate => candidate !== null)
    .sort((left, right) => {
      if (right.grossEdgePct !== left.grossEdgePct) {
        return right.grossEdgePct - left.grossEdgePct;
      }
      return right.maxGrossProfitUsd - left.maxGrossProfitUsd;
    })
    .slice(0, options.maxCandidates);

  return {
    scannedAt: new Date().toISOString(),
    marketCount: markets.length,
    evaluatedCount: marketsToEvaluate.length,
    candidateCount: candidates.length,
    candidates,
  };
}
