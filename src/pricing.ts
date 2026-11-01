import type { Usage } from './types.js';

export interface Price {
  input: number;
  output: number;
  /** Defaults to 10% of input. */
  cacheRead?: number;
  /** Defaults to 125% of input. */
  cacheWrite5m?: number;
  /** Defaults to 200% of input. */
  cacheWrite1h?: number;
  /** Rates applied when the prompt exceeds `above` tokens. */
  largePrompt?: { above: number; input: number; output: number; cacheRead?: number };
}

/**
 * USD per million tokens at first-party API rates, checked 2026-10.
 * Subscription plans, free tiers and cloud platforms bill differently, so every
 * figure the tool shows is an estimate. Keys match by longest prefix, which
 * covers dated model ids. Providers whose rates were not checked against their
 * price page are left out: pass those with --prices rather than trust a guess.
 * Gemini entries use the rates in force on 2026-10-30, including limited-time
 * ones on gemini-4-argon and the 3.6 and 3.8 flash models.
 */
export const BUILTIN_PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, largePrompt: { above: 100_000, input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gemini-4-argon': { input: 2, output: 10, cacheRead: 0.1 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cacheRead: 0.03 },
  'gemini-3.1-pro-preview': { input: 2, output: 12, cacheRead: 0.2, largePrompt: { above: 200_000, input: 4, output: 18, cacheRead: 0.4 } },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cacheRead: 0.025 },
  'gemini-3-flash-preview': { input: 0.5, output: 3, cacheRead: 0.05 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.125, largePrompt: { above: 200_000, input: 2.5, output: 15, cacheRead: 0.25 } },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.03 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cacheRead: 0.01 },
};

export type PriceTable = Record<string, Price>;

export function findPrice(model: string, table: PriceTable = BUILTIN_PRICES): Price | undefined {
  const id = model.replace(/^(?:[a-z]+\.)?anthropic\./, '').replace(/^anthropic\//, '');
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (id.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : undefined;
}

export function promptTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

/** Returns undefined when the model has no known price. */
export function costOf(model: string | undefined, u: Usage, table: PriceTable = BUILTIN_PRICES): number | undefined {
  const price = model ? findPrice(model, table) : undefined;
  if (!price) return undefined;
  const large = price.largePrompt && promptTokens(u) > price.largePrompt.above ? price.largePrompt : undefined;
  const tier = large ?? price;
  const speed = u.fast ? 2 : 1;
  const cost =
    u.input * tier.input +
    u.output * tier.output +
    u.cacheRead * (large?.cacheRead ?? price.cacheRead ?? tier.input * 0.1) +
    u.cacheWrite5m * (price.cacheWrite5m ?? tier.input * 1.25) +
    u.cacheWrite1h * (price.cacheWrite1h ?? tier.input * 2);
  return (cost * speed) / 1_000_000;
}

/** Extra paid for rewriting `tokens` to the cache instead of reading them. */
export function cacheRebuildPenalty(model: string | undefined, tokens: number, table: PriceTable = BUILTIN_PRICES): number | undefined {
  const price = model ? findPrice(model, table) : undefined;
  if (!price) return undefined;
  const write = price.cacheWrite5m ?? price.input * 1.25;
  const read = price.cacheRead ?? price.input * 0.1;
  return (tokens * (write - read)) / 1_000_000;
}
