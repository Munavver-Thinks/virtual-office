// List prices for estimates only: telemetry reports each request's cost, but not what the prompt cache saved. No DOM.
// Anthropic's prompt caching: a cache read costs 10% of the model's input price, a 5-minute cache write 125%.
// Real costs always come from telemetry (cost_usd); these prices only feed numbers labelled "about" / "estimate".

/** Input price in USD per million tokens, by model family. Ids are matched loosely ("claude-sonnet-4-6"). */
export const PRICES = [
  { family: "Opus 4.5 and later", input: 5, test: (m) => { const x = /opus-4-(\d{1,2})(?!\d)/.exec(m); return !!x && +x[1] >= 5; } },
  { family: "Opus 4 and 4.1, Opus 3", input: 15, test: (m) => /opus-4(?:-[01])?(?:-\d{8})?$|opus-4-[01](?!\d)|3-opus|opus-3/.test(m) },
  { family: "Sonnet", input: 3, test: (m) => /sonnet/.test(m) },
  { family: "Haiku 4.5", input: 1, test: (m) => /haiku-4/.test(m) },
  { family: "Haiku 3.5", input: 0.8, test: (m) => /3-5-haiku|haiku-3-5/.test(m) },
  { family: "Haiku 3", input: 0.25, test: (m) => /3-haiku|haiku-3(?!-5)/.test(m) },
];
export const CACHE_READ = 0.1, CACHE_WRITE = 1.25;

/** The price row for a model id, or null when it's not one we know. */
export function priceOf(model) {
  const m = String(model || "").toLowerCase();
  return (m && PRICES.find((p) => p.test(m))) || null;
}

/** What the cache saved, as an estimate: cache reads at full input price minus what they cost, minus the extra paid to
 *  write the cache. Null for an unknown model or no cache use. usd < 0 means the cache cost more than it saved. */
export function cacheSavings(tokens = {}, model) {
  const p = priceOf(model), read = +tokens.cacheRead || 0, write = +tokens.cacheWrite || 0;
  if (!p || (!read && !write)) return null;
  return { usd: ((read * (1 - CACHE_READ) - write * (CACHE_WRITE - 1)) * p.input) / 1e6, family: p.family, input: p.input };
}
