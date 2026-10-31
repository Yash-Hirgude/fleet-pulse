import { DEFAULT_APP_CONFIG } from '../config/app-config';
import { ConnectionManager, ConnectionState } from './connection-manager';
import {
  StreamTransport,
  TransportDefinition,
  TransportHandlers,
} from './transports/stream-transport';

const CFG = DEFAULT_APP_CONFIG.stream;

class FakeTransport implements StreamTransport {
  connected = false;
  closed = false;
  constructor(
    readonly kind: string,
    readonly h: TransportHandlers,
  ) {}
  connect() {
    this.connected = true;
  }
  close() {
    this.closed = true;
  }
}

function setup() {
  const created: FakeTransport[] = [];
  const states: ConnectionState[] = [];
  const events = {
    frame: vi.fn(),
    snapshot: vi.fn(),
    connected: vi.fn(),
    state: vi.fn((s: ConnectionState) => states.push(s)),
    unauthorized: vi.fn(() => Promise.resolve(true)),
  };
  const transports: TransportDefinition[] = ['websocket', 'sse', 'polling'].map((kind) => ({
    kind,
    label: kind,
    heartbeat: kind !== 'polling',
    create: (h) => {
      const t = new FakeTransport(kind, h);
      created.push(t);
      return t;
    },
  }));
  // random() = 0.5 -> delay is 75% of the exponential step: 750, 1500, 3000 ...
  const manager = new ConnectionManager({ config: CFG, transports, events, random: () => 0.5 });
  const last = () => created[created.length - 1];
  const state = () => states[states.length - 1];
  const kinds = () => created.map((t) => t.kind);
  return { manager, created, events, states, last, state, kinds };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** Time passes while the server keeps sending its 5 s pings on `transport`, as a healthy connection does. */
async function advanceWithPings(transport: FakeTransport, ms: number) {
  for (let left = ms; left > 0;) {
    const step = Math.min(5000, left);
    await advance(step);
    transport.h.frame('{"type":"ping"}');
    left -= step;
  }
}

describe('ConnectionManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts on the preferred transport and reports live once it opens', () => {
    const t = setup();
    t.manager.start();
    expect(t.state()).toEqual({ status: 'connecting', transport: 'websocket' });
    t.last().h.opened();
    expect(t.state()).toEqual({ status: 'live', transport: 'websocket' });
    expect(t.events.connected).toHaveBeenCalledWith('websocket');
  });

  it('falls back WebSocket -> SSE -> polling, 3 failures each, with growing delays', async () => {
    const t = setup();
    t.manager.start();

    // WebSocket: fail, wait 750 ms, fail, wait 1500 ms, fail -> SSE immediately (no third wait)
    t.last().h.closed('closed');
    expect(t.state()).toMatchObject({ status: 'reconnecting', transport: 'websocket' });
    expect((t.state() as { retryAt: number }).retryAt - Date.now()).toBe(750);
    await advance(749);
    expect(t.kinds()).toEqual(['websocket']);
    await advance(1);
    expect(t.kinds()).toEqual(['websocket', 'websocket']);

    t.last().h.closed('closed');
    expect((t.state() as { retryAt: number }).retryAt - Date.now()).toBe(1500);
    await advance(1500);
    t.last().h.closed('closed');
    expect(t.kinds()).toEqual(['websocket', 'websocket', 'websocket', 'sse']);
    expect(t.state()).toEqual({ status: 'connecting', transport: 'sse' });

    // SSE: the same, then polling
    for (let i = 0; i < 2; i++) {
      t.last().h.closed('error');
      await advance(5000);
    }
    t.last().h.closed('error');
    expect(t.kinds().slice(-1)).toEqual(['polling']);

    // polling is the last resort: it keeps retrying with growing, capped delays
    t.last().h.closed('error');
    expect(t.state()).toMatchObject({ status: 'reconnecting', transport: 'polling' });
  });

  it('falls back immediately when a transport does not connect within 5 s', async () => {
    const t = setup();
    t.manager.start();
    await advance(CFG.connectTimeoutMs - 1);
    expect(t.kinds()).toEqual(['websocket']);
    await advance(1);
    expect(t.kinds()).toEqual(['websocket', 'sse']);
    expect(t.created[0].closed).toBe(true);
  });

  it('resets the delay after a successful connection', async () => {
    const t = setup();
    t.manager.start();
    t.last().h.closed('closed');
    await advance(750);
    t.last().h.closed('closed');
    expect((t.state() as { retryAt: number }).retryAt - Date.now()).toBe(1500);
    await advance(1500);
    t.last().h.opened(); // success
    t.last().h.closed('closed'); // drops again
    expect((t.state() as { retryAt: number }).retryAt - Date.now()).toBe(750); // back to the first step
  });

  it('climbs back up: probes WebSocket every 30 s and moves up when it opens', async () => {
    const t = setup();
    t.manager.start();
    await advance(CFG.connectTimeoutMs); // ws never connects -> sse
    t.last().h.opened();
    expect(t.state()).toEqual({ status: 'live', transport: 'sse' });

    const sse = t.last();
    await advanceWithPings(sse, CFG.climbBackIntervalMs - 1);
    expect(t.kinds()).toEqual(['websocket', 'sse']);
    await advance(1); // probe starts; SSE stays in use meanwhile
    expect(t.kinds()).toEqual(['websocket', 'sse', 'websocket']);
    expect(t.created[1].closed).toBe(false);

    t.last().h.opened();
    expect(t.state()).toEqual({ status: 'live', transport: 'websocket' });
    expect(t.created[1].closed).toBe(true); // the lower transport is released
    expect(t.events.connected).toHaveBeenLastCalledWith('websocket');
  });

  it('a failed probe leaves the current transport alone and tries again 30 s later', async () => {
    const t = setup();
    t.manager.start();
    await advance(CFG.connectTimeoutMs);
    t.last().h.opened();
    const sse = t.last();
    await advanceWithPings(sse, CFG.climbBackIntervalMs);
    t.last().h.closed('closed'); // probe fails
    expect(t.state()).toEqual({ status: 'live', transport: 'sse' });
    expect(t.created[1].closed).toBe(false);
    await advanceWithPings(sse, CFG.climbBackIntervalMs);
    expect(t.kinds()).toEqual(['websocket', 'sse', 'websocket', 'websocket']);
  });

  it('climbs from polling to the highest transport that works, skipping the ones that do not', async () => {
    const t = setup();
    t.manager.start();
    await advance(CFG.connectTimeoutMs); // ws -> sse
    await advance(CFG.connectTimeoutMs); // sse -> polling
    t.last().h.opened();
    expect(t.state()).toEqual({ status: 'live', transport: 'polling' });

    await advance(CFG.climbBackIntervalMs);
    t.last().h.closed('closed'); // websocket probe fails
    expect(t.kinds().slice(-1)).toEqual(['sse']);
    t.last().h.opened(); // sse probe works
    expect(t.state()).toEqual({ status: 'live', transport: 'sse' });
  });

  it('treats silence as a dead connection after two missed pings, even though the socket looks open', async () => {
    const t = setup();
    t.manager.start();
    t.last().h.opened();
    await advance(5000);
    t.last().h.frame('{"type":"ping"}'); // a ping keeps it alive
    await advance(10_000);
    expect(t.state()).toEqual({ status: 'live', transport: 'websocket' });
    await advance(1500); // nothing for 11.5 s
    expect(t.state()).toMatchObject({ status: 'reconnecting' });
    expect(t.created[0].closed).toBe(true);
  });

  it('does not reconnect while offline and reconnects immediately when back online', async () => {
    const t = setup();
    t.manager.start();
    t.last().h.opened();
    t.manager.setOnline(false);
    expect(t.state()).toEqual({ status: 'offline' });
    expect(t.created[0].closed).toBe(true);
    await advance(120_000);
    expect(t.kinds()).toEqual(['websocket']); // no attempts at all

    t.manager.setOnline(true);
    expect(t.kinds()).toEqual(['websocket', 'websocket']); // immediately, no delay
    expect(t.state()).toEqual({ status: 'connecting', transport: 'websocket' });
  });

  it('refreshes the token on unauthorized and reconnects without counting a failure', async () => {
    const t = setup();
    t.manager.start();
    t.last().h.opened();
    t.last().h.closed('unauthorized');
    expect(t.events.unauthorized).toHaveBeenCalledTimes(1);
    await advance(0);
    expect(t.kinds()).toEqual(['websocket', 'websocket']);
    expect(t.state()).toEqual({ status: 'connecting', transport: 'websocket' });
  });

  it('ignores late events from a transport it already gave up on', () => {
    const t = setup();
    t.manager.start();
    const old = t.last();
    old.h.closed('closed');
    old.h.frame('{"type":"ping"}');
    expect(t.events.frame).not.toHaveBeenCalled();
  });

  it('stop() closes everything and nothing reconnects afterwards', async () => {
    const t = setup();
    t.manager.start();
    t.last().h.closed('closed');
    t.manager.stop();
    await advance(60_000);
    expect(t.kinds()).toEqual(['websocket']);
    expect(t.state()).toEqual({ status: 'stopped' });
  });
});
