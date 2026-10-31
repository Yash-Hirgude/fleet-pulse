export interface SseMessage {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

/** Incremental parser for text/event-stream. Chunks may split lines and messages anywhere. */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  constructor(private readonly onMessage: (message: SseMessage) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? ''; // the last piece may be an unfinished line
    for (const line of lines) this.line(line.endsWith('\r') ? line.slice(0, -1) : line);
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) this.onMessage({ event: this.event || 'message', data: this.data.join('\n'), id: this.id });
      this.event = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
  }
}