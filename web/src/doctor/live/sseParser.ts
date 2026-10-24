/**
 * Incremental Server-Sent Events parser (Req 19.1; design §15 "live/sseParser.ts").
 *
 * Follows the WHATWG event-stream interpretation rules:
 * - a leading U+FEFF BOM at the very start of the stream is dropped;
 * - lines end with CRLF, LF or CR. A CR at the end of a chunk is treated as a
 *   line end and a LF at the start of the next chunk is then skipped, so a
 *   CRLF split across chunks is still one line break;
 * - lines starting with ':' are comments (e.g. the server's ": ping") and ignored;
 * - `field: value` (one leading space of the value stripped), or a bare `field`
 *   with an empty value;
 * - `event` sets the event type, `data` lines are joined with "\n", `id` sets
 *   the last event id (ignored if it contains U+0000), `retry` (ASCII digits
 *   only) sets the reconnection time; unknown fields are ignored;
 * - a blank line dispatches the event. An event with no data is not dispatched.
 *   The type defaults to "message".
 *
 * Output is independent of how the stream is split into chunks (Property 24).
 * Pure: no DOM, no I/O.
 */

export interface SseEvent {
  /** Event type; "message" when no `event:` field was given. */
  event: string;
  /** Data lines joined with "\n" (trailing newline removed). */
  data: string;
  /** Last event id at dispatch time ("" when none was ever set). */
  id: string;
}

export interface SseParser {
  /** Feed the next decoded text chunk. Events are dispatched synchronously. */
  push(chunk: string): void;
  /**
   * End of stream: any incomplete event (no terminating blank line) is
   * discarded, per the spec. The parser is reset for reuse.
   */
  end(): void;
  /** Latest `retry:` value in milliseconds, or null if none was received. */
  readonly retry: number | null;
  /** Last event id buffer (persists across events, per the spec). */
  readonly lastEventId: string;
}

const LINE_BREAK = /[\r\n]/;
const DIGITS = /^[0-9]+$/;

export function createSseParser(
  onEvent: (event: SseEvent) => void,
  onRetry?: (ms: number) => void,
): SseParser {
  let started = false; // BOM check done
  let skipLF = false; // previous chunk ended with CR
  let pending = ''; // partial line carried across chunks

  let eventType = '';
  let data = '';
  let lastEventId = '';
  let retry: number | null = null;

  function dispatch(): void {
    if (data === '') {
      eventType = '';
      return;
    }
    const ev: SseEvent = {
      event: eventType === '' ? 'message' : eventType,
      data: data.endsWith('\n') ? data.slice(0, -1) : data,
      id: lastEventId,
    };
    eventType = '';
    data = '';
    onEvent(ev);
  }

  function processLine(line: string): void {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.charCodeAt(0) === 0x3a /* ':' */) return; // comment
    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === 0x20 /* ' ' */) value = value.slice(1);
    }
    switch (field) {
      case 'event':
        eventType = value;
        break;
      case 'data':
        data += value + '\n';
        break;
      case 'id':
        if (!value.includes('\u0000')) lastEventId = value;
        break;
      case 'retry':
        if (DIGITS.test(value)) {
          retry = Number.parseInt(value, 10);
          onRetry?.(retry);
        }
        break;
      default:
        break; // unknown field: ignored
    }
  }

  function push(chunk: string): void {
    if (chunk.length === 0) return;
    let s = chunk;
    if (!started) {
      started = true;
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
      if (s.length === 0) return;
    }
    let start = 0;
    if (skipLF) {
      skipLF = false;
      if (s.charCodeAt(0) === 0x0a) start = 1;
    }
    // Local regex: a shared /g regex would break if onEvent re-entered a parser.
    const lineBreak = new RegExp(LINE_BREAK.source, 'g');
    lineBreak.lastIndex = start;
    let m: RegExpExecArray | null;
    while ((m = lineBreak.exec(s)) !== null) {
      let idx = m.index;
      const line = pending + s.slice(start, idx);
      pending = '';
      if (s.charCodeAt(idx) === 0x0d) {
        if (idx + 1 < s.length) {
          if (s.charCodeAt(idx + 1) === 0x0a) idx += 1;
        } else {
          skipLF = true; // CRLF may be split across chunks
        }
      }
      start = idx + 1;
      lineBreak.lastIndex = start;
      processLine(line);
    }
    pending += s.slice(start);
  }

  function end(): void {
    started = false;
    skipLF = false;
    pending = '';
    eventType = '';
    data = '';
  }

  return {
    push,
    end,
    get retry() {
      return retry;
    },
    get lastEventId() {
      return lastEventId;
    },
  };
}
