import { StreamTransport, TransportHandlers } from './stream-transport';

const CLOSE_UNAUTHORIZED = 4401;

export class WebSocketTransport implements StreamTransport {
  private socket: WebSocket | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly token: () => string | null,
    private readonly handlers: TransportHandlers,
    private readonly createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {}

  connect(): void {
    const token = this.token();
    if (!token) {
      this.handlers.closed('unauthorized');
      return;
    }
    // Browsers cannot set headers on a WebSocket, so the contract allows the token as a query parameter.
    const socket = this.createSocket(`${this.wsUrl}/stream?access_token=${encodeURIComponent(token)}`);
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.handlers.opened();
    };
    // A refused upgrade (e.g. 503) fires `error` and, in browsers, `close` (1006). Some WebSocket implementations
    // never fire `close` for it, so a failure before the socket opened is reported from `error` as well.
    socket.onerror = () => {
      if (!opened) this.handlers.closed('error');
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.handlers.frame(ev.data);
    };
    socket.onclose = (ev) => this.handlers.closed(ev.code === CLOSE_UNAUTHORIZED ? 'unauthorized' : 'closed');
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    socket.close();
  }
}