import { randomUUID } from 'node:crypto';

// Fixed OneBot transport, not a general HTTP or platform-action tool.
export class OneBotClient {
  #url; #socket; #pending = new Map(); #timer; #stopped = true; #onEvent; #onStatus;
  constructor({ url, token, onEvent, onStatus = () => {}, WebSocketImpl = WebSocket }) {
    const target = new URL(url);
    if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1' || target.port !== '3001' || target.search || target.hash) throw new Error('ONEBOT_CONFIG');
    target.searchParams.set('access_token', token);
    this.#url = target.href; this.WebSocketImpl = WebSocketImpl; this.#onEvent = onEvent; this.#onStatus = onStatus;
  }
  get connected() { return this.#socket?.readyState === 1; }
  start() { this.#stopped = false; this.#connect(); }
  #connect() {
    if (this.#stopped) return;
    const socket = this.#socket = new this.WebSocketImpl(this.#url);
    socket.addEventListener('open', () => this.#onStatus(true));
    socket.addEventListener('message', ({ data }) => {
      if (typeof data !== 'string' || data.length > 13 * 1024 * 1024) return;
      let value; try { value = JSON.parse(data); } catch { return; }
      if (typeof value.echo === 'string' && this.#pending.has(value.echo)) {
        const pending = this.#pending.get(value.echo); this.#pending.delete(value.echo); clearTimeout(pending.timer);
        if (value.status === 'ok' && value.retcode === 0) pending.resolve(value.data); else pending.reject(new Error('ONEBOT_REJECTED'));
      } else if (value.post_type && data.length <= 1048576) void Promise.resolve(this.#onEvent(value)).catch(() => {});
    });
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', () => {
      this.#onStatus(false);
      for (const item of this.#pending.values()) { clearTimeout(item.timer); item.reject(new Error('ONEBOT_DELIVERY_UNKNOWN')); }
      this.#pending.clear();
      if (!this.#stopped) this.#timer = setTimeout(() => this.#connect(), 3000);
    });
  }
  call(action, params = {}) {
    if (!['get_login_info', 'send_private_msg', 'get_record', 'get_image', 'get_msg'].includes(action)) return Promise.reject(new Error('ONEBOT_ACTION_DENIED'));
    if (!this.connected) return Promise.reject(new Error('ONEBOT_DISCONNECTED'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(echo); reject(new Error('ONEBOT_DELIVERY_UNKNOWN')); }, ['get_record', 'get_image'].includes(action) ? 45000 : 15000);
      this.#pending.set(echo, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ action, params, echo }));
    });
  }
  stop() {
    this.#stopped = true; clearTimeout(this.#timer);
    this.#socket?.close();
    for (const item of this.#pending.values()) { clearTimeout(item.timer); item.reject(new Error('ONEBOT_STOPPED')); }
    this.#pending.clear();
  }
}
