/** Generic JSON-over-HTTP ASR adapter (base64 audio in, text out). */

/**
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.name]
 * @param {Record<string,string>} [options.headers]
 * @param {(request: object) => { body: string, headers?: Record<string,string> }} [options.buildRequest]
 * @param {(payload: any, request: object) => object} [options.parseResponse]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createHttpAsrAdapter({
  url,
  name = "http-asr",
  headers = {},
  buildRequest = (request) => ({
    body: JSON.stringify({
      ...request,
      audio: request.audio instanceof Uint8Array
        ? Buffer.from(request.audio).toString("base64")
        : request.audio,
    }),
  }),
  parseResponse = (payload) => ({ text: String(payload.text ?? "") }),
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof url !== "string" || url === "") throw new Error("ASR url is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");
  return {
    name,
    async transcribe(request) {
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
      return parseResponse(await response.json(), payload);
    },
  };
}
