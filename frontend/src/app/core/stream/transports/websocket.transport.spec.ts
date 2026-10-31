import { WebSocketTransport } from './websocket.transport';
import { TransportHandlers } from './stream-transport';

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalled = false;
  constructor(readonly url: string) {}
  close() {
    this.closeCalled = true;
  }
}

function setup(token: string | null = 'tok en') {
  const socket: { current?: FakeSocket } = {};
  const handlers: TransportHandlers = {
    opened: vi.fn(),
    frame: vi.fn(),
    snapshot: vi.fn(),
    closed: vi.fn(),
  };
  const transport = new WebSocketTransport(
    'ws://x',
    () => token,
    handlers,
    (url) => {
      socket.current = new FakeSocket(url);
      return socket.current as unknown as WebSocket;
    },
  );
  return { transport, handlers, socket };
}

describe('WebSocketTransport', () => {
  it('passes the token as an encoded query parameter and forwards frames', () => {
    const { transport, handlers, socket } = setup();
    transport.connect();
    expect(socket.current?.url).toBe('ws://x/stream?access_token=tok%20en');
    socket.current?.onopen?.();
    socket.current?.onmessage?.({ data: '{"type":"ping"}' });
    expect(handlers.opened).toHaveBeenCalled();
    expect(handlers.frame).toHaveBeenCalledWith('{"type":"ping"}');
  });

  it('maps close code 4401 to unauthorized and anything else to closed', () => {
    const a = setup();
    a.transport.connect();
    a.socket.current?.onclose?.({ code: 4401 });
    expect(a.handlers.closed).toHaveBeenCalledWith('unauthorized');

    const b = setup();
    b.transport.connect();
    b.socket.current?.onclose?.({ code: 1006 });
    expect(b.handlers.closed).toHaveBeenCalledWith('closed');
  });

  it('reports a refused upgrade (error before open) as a failure', () => {
    const { transport, handlers, socket } = setup();
    transport.connect();
    socket.current?.onerror?.();
    expect(handlers.closed).toHaveBeenCalledWith('error');
  });

  it('does not connect without a token', () => {
    const { transport, handlers, socket } = setup(null);
    transport.connect();
    expect(socket.current).toBeUndefined();
    expect(handlers.closed).toHaveBeenCalledWith('unauthorized');
  });

  it('close() detaches the handlers so a closed transport can never call back', () => {
    const { transport, handlers, socket } = setup();
    transport.connect();
    const s = socket.current as FakeSocket;
    transport.close();
    expect(s.closeCalled).toBe(true);
    expect(s.onclose).toBeNull();
    expect(handlers.closed).not.toHaveBeenCalled();
  });
});
