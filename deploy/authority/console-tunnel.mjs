// The pieces of open-world.mjs that decide what is forwarded and what the console is told (tested on their own).
import net from 'node:net';

/** The room page on the production host (companion-room.service, loopback only). */
export const ROOM_REMOTE_PORT = 4173;
/** Local ports tried for the room, in order; the first free one is used. */
export const ROOM_LOCAL_PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) => 4173 + index));

/** ssh arguments: the console's 3082, and the room on `roomPort` of this machine when there is one (null: skipped). */
export function tunnelArgs(host, roomPort) {
  return ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-N',
    '-L', '127.0.0.1:3082:127.0.0.1:3082', ...(roomPort ? ['-L', `127.0.0.1:${roomPort}:127.0.0.1:${ROOM_REMOTE_PORT}`] : []), host];
}

/** The console's address: the access code in the fragment, and the room's local port beside it when it is forwarded. */
export function consoleURL(token, roomPort) {
  const url = new URL('http://127.0.0.1:3082/');
  url.hash = 'companion-operator=' + token + (roomPort ? '&room=' + roomPort : '');
  return url;
}

/** Whether nothing listens on 127.0.0.1:`port` (it can be bound right now). */
export function portFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** The first free local port for the room, or null when all are taken (the room is then not forwarded). */
export async function pickRoomPort(isFree = portFree, candidates = ROOM_LOCAL_PORTS) {
  for (const port of candidates) if (await isFree(port)) return port;
  return null;
}
