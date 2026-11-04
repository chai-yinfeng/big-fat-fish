/** Generic JSON-over-HTTP TTS adapter. No provider SDK, no vendor lock-in. */

/**
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.name]
 * @param {Record<string,string>} [options.headers]
 * @param {(request: object) => { body: string, headers?: Record<string,string> }} [options.buildRequest]
 * @param {(response: Response, request: object) => Promise<object>|object} [options.parseResponse]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createHttpTtsAdapter({
  url,
  name = "http-tts",
  headers = {},
  buildRequest = (request) => ({ body: JSON.stringify(request) }),
  parseResponse = async (response) => ({
    audio: new Uint8Array(await response.arrayBuffer()),
    mime: response.headers.get("content-type") ?? "audio/mpeg",
  }),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof url !== "string" || url === "") throw new Error("TTS url is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");
  return {
    name,
    async synthesize(request) {
      // `signal` is transport-only: it must not leak into the JSON payload.
      const { signal, ...payload } = request ?? {};
      const built = buildRequest(payload);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
          ...(built.headers ?? {}),
        },
        body: built.body,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`${name} HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      const parsed = await parseResponse(response, payload);
      if (!parsed || !(parsed.audio instanceof Uint8Array)) {
        throw new Error(`${name} returned no audio bytes`);
      }
      return parsed;
    },
  };
}
