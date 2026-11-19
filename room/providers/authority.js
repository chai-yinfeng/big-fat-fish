// The live provider: the room state Authority itself computed (authority/src/room.js, `GET /v1/room`), as this
// page's own server hands it on at `state` (serve.mjs, real mode). The page holds no credential and never talks to
// Authority; whatever arrives is held to the contract again here before it is drawn.
import { validateRoomState } from '../state.js';

/** How often the page asks. The server answers from a short cache, so more viewers do not mean more reads. */
export const POLL_MS = 5000;
/** A value from the server as a room state of Authority, or ROOM_STATE_INVALID. */
export function acceptLive(value) {
  const state = validateRoomState(value);
  if (state.source !== 'authority') throw Object.assign(new Error('Not a live room state'), { code: 'ROOM_STATE_INVALID' });
  return state;
}
/** The current state; null when this server offers none (fake mode answers 404); throws when it cannot be read now. */
export async function liveState() {
  const response = await fetch('state', { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('房间状态暂时读不到，稍后会再试。');
  try { return acceptLive(await response.json()); } catch { throw new Error('房间状态暂时读不到，稍后会再试。'); }
}
