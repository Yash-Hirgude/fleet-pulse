import { SseMessage, SseParser } from './sse-parser';

function parse(...chunks: string[]): SseMessage[] {
  const out: SseMessage[] = [];
  const parser = new SseParser((m) => out.push(m));
  chunks.forEach((c) => parser.push(c));
  return out;
}

describe('SseParser', () => {
  it('parses id, event and data', () => {
    expect(parse('id: 7\nevent: metric\ndata: {"a":1}\n\n')).toEqual([
      { id: '7', event: 'metric', data: '{"a":1}' },
    ]);
  });

  it('handles chunks that split a line or a message anywhere', () => {
    const whole = 'id: 7\nevent: metric\ndata: {"a":1}\n\nevent: ping\ndata: {"b":2}\n\n';
    for (let cut = 1; cut < whole.length; cut++) {
      const messages = parse(whole.slice(0, cut), whole.slice(cut));
      expect(messages.map((m) => m.data)).toEqual(['{"a":1}', '{"b":2}']);
    }
  });

  it('ignores comments and keep-alives, joins multi-line data, tolerates CRLF', () => {
    expect(parse(': connected\n\n')).toEqual([]);
    expect(parse('event: x\r\ndata: a\r\ndata: b\r\n\r\n')).toMatchObject([
      { event: 'x', data: 'a\nb' },
    ]);
  });

  it('delivers invalid JSON payloads untouched (the stream parser counts them as malformed)', () => {
    expect(parse('event: metric\ndata: {"type":"metr\n\n')[0].data).toBe('{"type":"metr');
  });
});
