import { SseParser } from './sse-parser';
import { StreamTransport, TransportHandlers } from './stream-transport';

/**
 * SSE over fetch instead of EventSource: EventSource hides the HTTP status (so a 401 looks like any other error)
 * and reconnects on its own. Here the connection manager owns every reconnect decision.
 */
export class SseTransport implements StreamTransport {
  private abort: AbortController | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly token: () => string | null,
    private readonly handlers: TransportHandlers,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  connect(): void {
    const token = this.token();
    if (!token) {
      this.handlers.closed('unauthorized');
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    void this.run(token, abort);
  }

  close(): void {
    this.abort?.abort();
    this.abort = null;
  }

  private async run(token: string, abort: AbortController): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/stream/sse`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal: abort.signal,
      });
      if (res.status === 401) return this.handlers.closed('unauthorized');
      if (!res.ok || !res.body) return this.handlers.closed('error');

      this.handlers.opened();
      const decoder = new TextDecoder();
      const parser = new SseParser((m) => {
        if (m.event === 'metric' || m.event === 'ping') this.handlers.frame(m.data);
      });
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      this.handlers.closed('closed');
    } catch {
      if (!abort.signal.aborted) this.handlers.closed('error');
    }
  }
}
