/**
 * SSE parser and reconnect backoff unit tests (task 20.2).
 * Requirements: 19.1, 19.4, 44.6.
 */
import { describe, expect, it } from 'vitest';
import { createSseParser, type SseEvent } from './sseParser';
import { BACKOFF_DELAYS_MS, backoffDelay } from './backoff';

function collect() {
  const events: SseEvent[] = [];
  const retries: number[] = [];
  const parser = createSseParser(
    (e) => events.push(e),
    (ms) => retries.push(ms),
  );
  return { parser, events, retries };
}

/** Feed `chunks` into a fresh parser and return the dispatched events. */
function parse(...chunks: string[]) {
  const c = collect();
  for (const chunk of chunks) c.parser.push(chunk);
  return c;
}

// Frames exactly as backend/app/routers/alerts.py + events.format_sse emit them.
const RETRY_FRAME = 'retry: 3000\n\n';
const HELLO_FRAME = 'event: hello\ndata: {"server_time":"2025-01-15T10:00:00Z"}\n\n';
const PING_FRAME = ': ping\n\n';
const ALERT_PAYLOAD = '{"alert":{"id":"a1","mother_id":"m1","codes":["R1"],"status":"open"}}';
const ALERT_FRAME = `event: alert.created\ndata: ${ALERT_PAYLOAD}\n\n`;
const BACKEND_STREAM = RETRY_FRAME + HELLO_FRAME + PING_FRAME + ALERT_FRAME;

describe('createSseParser – backend frames', () => {
  it('parses the backend stream: retry, hello, ping comment, alert.created', () => {
    const { parser, events, retries } = parse(BACKEND_STREAM);
    expect(retries).toEqual([3000]);
    expect(parser.retry).toBe(3000);
    expect(events).toEqual([
      { event: 'hello', data: '{"server_time":"2025-01-15T10:00:00Z"}', id: '' },
      { event: 'alert.created', data: ALERT_PAYLOAD, id: '' },
    ]);
    expect(JSON.parse(events[1].data).alert.id).toBe('a1');
  });

  it('retry-only frame dispatches no event', () => {
    const { events, retries } = parse(RETRY_FRAME);
    expect(events).toEqual([]);
    expect(retries).toEqual([3000]);
  });

  it('gives the same events when the stream is fed one character at a time', () => {
    const { events, retries } = parse(...BACKEND_STREAM.split(''));
    expect(events).toEqual(parse(BACKEND_STREAM).events);
    expect(retries).toEqual([3000]);
  });

  it('buffers a frame split mid-line across chunks', () => {
    const { events } = parse('event: hel', 'lo\ndata: {"a"', ':1}\n', '\n');
    expect(events).toEqual([{ event: 'hello', data: '{"a":1}', id: '' }]);
  });
});

describe('createSseParser – comments and fields', () => {
  it('ignores comment lines, including inside an event', () => {
    const { events } = parse(': ping\n\n:\n\nevent: x\n: note\ndata: 1\n\n');
    expect(events).toEqual([{ event: 'x', data: '1', id: '' }]);
  });

  it('joins multi-line data with \\n', () => {
    const { events } = parse('data: line1\ndata: line2\ndata:\ndata: line4\n\n');
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2\n\nline4', id: '' }]);
  });

  it('defaults the type to "message" and resets the type after dispatch', () => {
    const { events } = parse('event: a\ndata: 1\n\ndata: 2\n\n');
    expect(events.map((e) => e.event)).toEqual(['a', 'message']);
  });

  it('strips only one leading space from the value', () => {
    const { events } = parse('data:  two\n\ndata:none\n\n');
    expect(events.map((e) => e.data)).toEqual([' two', 'none']);
  });

  it('treats a bare field name as an empty value and ignores unknown fields', () => {
    const { events } = parse('data\nfoo: bar\n\n');
    expect(events).toEqual([{ event: 'message', data: '', id: '' }]);
  });

  it('does not dispatch an event without data', () => {
    const { events } = parse('event: hello\n\nid: 7\n\n');
    expect(events).toEqual([]);
  });

  it('does not let an undispatched event type leak into the next event', () => {
    const { events } = parse('event: orphan\n\ndata: x\n\n');
    expect(events).toEqual([{ event: 'message', data: 'x', id: '' }]);
  });
});

describe('createSseParser – line endings', () => {
  const expected = [
    { event: 'hello', data: 'a\nb', id: '' },
    { event: 'message', data: 'c', id: '' },
  ];

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ])('handles %s line endings', (_name, nl) => {
    const text = ['event: hello', 'data: a', 'data: b', '', 'data: c', '', ''].join(nl);
    expect(parse(text).events).toEqual(expected);
  });

  it('handles mixed line endings', () => {
    const { events } = parse('event: hello\r\ndata: a\rdata: b\n\r\ndata: c\r\r');
    expect(events).toEqual(expected);
  });

  it('treats CRLF split across chunks as a single line break', () => {
    const { events } = parse('data: a\r', '\ndata: b\r', '\n\r', '\n');
    expect(events).toEqual([{ event: 'message', data: 'a\nb', id: '' }]);
  });

  it('a CR at the end of a chunk followed by a non-LF starts a new line', () => {
    const { events } = parse('data: a\r', 'data: b\r', '\r');
    expect(events).toEqual([{ event: 'message', data: 'a\nb', id: '' }]);
  });
});

describe('createSseParser – BOM', () => {
  it('drops a leading BOM', () => {
    const { events } = parse('\uFEFFdata: x\n\n');
    expect(events).toEqual([{ event: 'message', data: 'x', id: '' }]);
  });

  it('drops a BOM that arrives as its own first chunk', () => {
    const { events } = parse('\uFEFF', 'event: hello\ndata: x\n\n');
    expect(events).toEqual([{ event: 'hello', data: 'x', id: '' }]);
  });

  it('keeps a BOM that is not at the start of the stream', () => {
    const { events } = parse('data: x\n\n', '\uFEFFdata: y\n\n');
    // "\uFEFFdata" is an unknown field name, so the second event has no data.
    expect(events).toEqual([{ event: 'message', data: 'x', id: '' }]);
  });
});

describe('createSseParser – retry', () => {
  it('accepts ASCII-digit values only', () => {
    const { parser, retries } = parse('retry: 3000\n', 'retry: 12a\nretry: -5\nretry: 1.5\nretry:\n\n');
    expect(retries).toEqual([3000]);
    expect(parser.retry).toBe(3000);
  });

  it('keeps the latest valid value', () => {
    const { parser, retries } = parse('retry: 3000\n\nretry: 500\n\n');
    expect(retries).toEqual([3000, 500]);
    expect(parser.retry).toBe(500);
  });

  it('is null before any retry field', () => {
    expect(parse('data: x\n\n').parser.retry).toBeNull();
  });
});

describe('createSseParser – id', () => {
  it('attaches the last event id and persists it across events', () => {
    const { parser, events } = parse('id: 1\ndata: a\n\ndata: b\n\nid: 2\ndata: c\n\n');
    expect(events.map((e) => e.id)).toEqual(['1', '1', '2']);
    expect(parser.lastEventId).toBe('2');
  });

  it('an empty id resets the last event id', () => {
    const { events } = parse('id: 1\ndata: a\n\nid\ndata: b\n\n');
    expect(events.map((e) => e.id)).toEqual(['1', '']);
  });

  it('ignores an id containing U+0000', () => {
    const { parser, events } = parse('id: 1\ndata: a\n\nid: 2\u00003\ndata: b\n\n');
    expect(events.map((e) => e.id)).toEqual(['1', '1']);
    expect(parser.lastEventId).toBe('1');
  });

  it('sets the id even when the event is not dispatched', () => {
    const { parser, events } = parse('id: 9\n\n');
    expect(events).toEqual([]);
    expect(parser.lastEventId).toBe('9');
  });
});

describe('createSseParser – end()', () => {
  it('discards an incomplete trailing event', () => {
    const { parser, events } = parse('data: done\n\n', 'event: hello\ndata: partial\n');
    parser.end();
    expect(events).toEqual([{ event: 'message', data: 'done', id: '' }]);
  });

  it('discards a partial line and resets for reuse', () => {
    const { parser, events } = parse('data: half');
    parser.end();
    expect(events).toEqual([]);
    // Next stream (reconnect): fresh state, BOM check applies again.
    parser.push('\uFEFFevent: hello\ndata: x\n\n');
    expect(events).toEqual([{ event: 'hello', data: 'x', id: '' }]);
  });

  it('clears a pending split CRLF so the next stream starts cleanly', () => {
    const { parser, events } = parse('data: a\r');
    parser.end();
    parser.push('\ndata: b\n\n');
    // The leading LF is now a blank line (no-op, nothing buffered), then "b".
    expect(events).toEqual([{ event: 'message', data: 'b', id: '' }]);
  });
});

describe('backoffDelay', () => {
  it('follows 1000, 2000, 5000, 10000 then stays at 10000', () => {
    expect([0, 1, 2, 3, 4, 5, 10, 100].map(backoffDelay)).toEqual([
      1000, 2000, 5000, 10000, 10000, 10000, 10000, 10000,
    ]);
    expect(BACKOFF_DELAYS_MS).toEqual([1000, 2000, 5000, 10000]);
  });

  it('treats invalid attempts as the first attempt', () => {
    expect(backoffDelay(-1)).toBe(1000);
    expect(backoffDelay(Number.NaN)).toBe(1000);
  });
});
