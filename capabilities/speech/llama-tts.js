import fs from 'node:fs';
import path from 'node:path';
import { failure } from './config.js';

export const TTS_BACKENDS = ['vulkan', 'cpu'];
// Stable reasons recorded when `auto` runs on CPU (no paths, no native stderr).
export const VULKAN_UNSUPPORTED = 'SPEECH_VULKAN_UNSUPPORTED'; // llama-tts built without the Vulkan backend
export const VULKAN_NO_DEVICE = 'SPEECH_VULKAN_NO_DEVICE'; // no accessible /dev/dri/renderD* (e.g. not in the render group)
export const VULKAN_FAILED = 'SPEECH_VULKAN_FAILED'; // a Vulkan run exited non-zero, crashed or timed out
export const FALLBACK_CODES = [VULKAN_UNSUPPORTED, VULKAN_NO_DEVICE, VULKAN_FAILED];
// A failed native run that may be retried on another backend.
export const BACKEND_FAILED = 'SPEECH_BACKEND_FAILED';

// Vulkan offloads every layer and the mmproj vocoder (measured RTF 0.69 vs ~3.3 CPU
// under the content unit's CPUQuota=200%); --no-mmproj-offload would forfeit most of it.
const BACKEND_ARGS = { vulkan: ['--device', 'Vulkan0', '-ngl', '99'], cpu: ['--device', 'none', '-ngl', '0', '--no-mmproj-offload'] };

export function llamaTtsArgs({ e, numThreads, backend, reference, prompt, outputFile }) {
  if (!TTS_BACKENDS.includes(backend)) throw failure('SPEECH_REQUEST');
  return ['-m', e.model, '-mm', e.mmproj, ...BACKEND_ARGS[backend], '-t', String(numThreads), '-c', '2048', '-n', String(e.maxFrames), '--tts-lang', e.language, '--tts-speaker-file', reference, '-f', prompt, '--output', outputFile];
}

/** Cheap pre-checks before trying Vulkan: null when it may work, else a fallback code.
 * A Vulkan build (shared libs) puts libggml-vulkan.so next to llama-tts. */
export function vulkanProbe(executable, { dri = '/dev/dri' } = {}) {
  if (!fs.existsSync(path.join(path.dirname(executable), 'libggml-vulkan.so'))) return VULKAN_UNSUPPORTED;
  let nodes = [];
  try { nodes = fs.readdirSync(dri).filter(name => /^renderD\d+$/.test(name)); } catch {}
  const usable = nodes.some(name => { try { fs.accessSync(path.join(dri, name), fs.constants.R_OK | fs.constants.W_OK); return true; } catch { return false; } });
  return usable ? null : VULKAN_NO_DEVICE;
}

/** Runs one synthesis on the configured device. run(backend, timeoutMs?) performs the
 * native call and rejects with BACKEND_FAILED for a retryable native failure.
 * `known` is a fallback code the caller already observed in this process (auto only).
 * Returns { backend, fallback } where fallback is why `auto` used the CPU. */
export async function synthesizeOnDevice({ device, known, probe, run, timeoutMs }) {
  if (device === 'cpu') { await run('cpu'); return { backend: 'cpu', fallback: null }; }
  if (device === 'vulkan') {
    if (probe()) throw failure('SPEECH_NOT_CONFIGURED');
    await run('vulkan');
    return { backend: 'vulkan', fallback: null };
  }
  const reason = FALLBACK_CODES.includes(known) ? known : probe();
  if (reason) { await run('cpu'); return { backend: 'cpu', fallback: reason }; }
  // The Vulkan attempt gets half the request budget so the CPU retry still fits.
  try { await run('vulkan', Math.floor(timeoutMs / 2)); return { backend: 'vulkan', fallback: null }; }
  catch (error) { if (error.code !== BACKEND_FAILED) throw error; }
  await run('cpu');
  return { backend: 'cpu', fallback: VULKAN_FAILED };
}
