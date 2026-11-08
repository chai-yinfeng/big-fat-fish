/** Traditional -> Simplified Chinese hook for Qwen3-ASR output (safety net).
 * Stock Qwen3-ASR normally answers Mandarin in Simplified; one benchmark clip
 * came back Traditional with Chinese numerals. Identity until a conversion
 * (dependency or table) is approved. Pure and synchronous: it runs inside the
 * speech worker before the transcript leaves the child process. */
export function toSimplifiedChinese(text) {
  return text;
}
