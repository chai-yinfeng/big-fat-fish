/** Ordered TTS fallback with a short-lived in-memory cache. */

/**
 * @param {object} options
 * @param {{ name: string, synthesize: (request: object) => Promise<object> }}[] options.providers
 * @param {Map<string, {output: object, at: number}>} [options.cache]
 * @param {(event: object) => void} [options.onFallback]
 * @param {number} [options.cacheTtlMs] - 0 disables the cache (default 5 minutes).
 * @param {() => number} [options.now]
 */
export function createTtsRouter({
  providers = [],
  cache = new Map(),
  onFallback = undefined,
  cacheTtlMs = 5 * 60_000,
  now = Date.now,
} = {}) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("at least one TTS provider is required");
  }
  const names = providers.map((provider) => provider.name);
  return {
    providers: [...names],
    async synthesize(request, { prefer = undefined, signal = undefined } = {}) {
      // Transport cancellation is not part of provider identity or the cache key.
      const { signal: requestSignal, ...cacheable } = request ?? {};
      const transportSignal = signal ?? requestSignal;
      const key = JSON.stringify({ prefer: prefer ?? "auto", ...cacheable });
      if (cacheTtlMs > 0 && cache.has(key)) {
        const entry = cache.get(key);
        if (entry && now() - entry.at <= cacheTtlMs) {
          return { ...entry.output, cached: true };
        }
        cache.delete(key);
      }
      const ordered = prefer === undefined
        ? providers
        : [
          ...providers.filter((provider) => provider.name === prefer),
          ...providers.filter((provider) => provider.name !== prefer),
        ];
      const errors = [];
      for (const provider of ordered) {
        try {
          const result = await provider.synthesize({ ...cacheable, ...(transportSignal === undefined ? {} : { signal: transportSignal }) });
          const output = { ...result, provider: provider.name };
          // Never cache a fallback result: a provider that is temporarily down
          // (missing key, quota) must get another chance on the next request.
          if (cacheTtlMs > 0 && errors.length === 0) {
            cache.set(key, { output, at: now() });
          }
          if (errors.length > 0) {
            onFallback?.({ to: provider.name, errors: [...errors] });
          }
          return { ...output, cached: false };
        } catch (error) {
          errors.push({ provider: provider.name, message: String(error?.message ?? error) });
        }
      }
      throw new AggregateError(
        errors.map((entry) => new Error(`${entry.provider}: ${entry.message}`)),
        "all TTS providers failed",
      );
    },
  };
}
