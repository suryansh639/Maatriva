"""In-process event broker feeding the doctor SSE stream (Req 18).

Publishers are sync route handlers and background jobs running on worker
threads; subscribers are asyncio queues owned by the SSE stream generator on
the event loop. ``publish`` hops onto the captured loop with
``call_soon_threadsafe`` so the queues are only ever touched from the loop
thread. Single-process assumption: one uvicorn worker (documented limitation).

Callers MUST publish only after the related database commit (Req 18.6).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

log = logging.getLogger(__name__)

QUEUE_MAXSIZE = 100

# Close marker: the stream generator ends the stream when it dequeues this.
_CLOSE = object()


def format_sse(event: str | None, data: Any, id: str | None = None) -> str:
    """Format one SSE frame: optional ``id`` and ``event`` lines, compact JSON
    ``data`` lines (any embedded newline split into separate ``data:`` lines),
    terminated by a blank line (Req 18.10)."""
    lines: list[str] = []
    if id is not None:
        lines.append(f"id: {id}")
    if event is not None:
        lines.append(f"event: {event}")
    payload = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    lines.extend(f"data: {part}" for part in payload.split("\n"))
    return "\n".join(lines) + "\n\n"


class EventBroker:
    """Per-facility fan-out of pre-formatted SSE frames."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subs: dict[str, set[asyncio.Queue]] = {}

    # -- loop management -------------------------------------------------
    def capture_loop(self, loop: asyncio.AbstractEventLoop | None = None) -> None:
        """Capture the event loop that owns the subscriber queues. Called from
        the lifespan; defaults to the currently running loop."""
        self._loop = loop if loop is not None else asyncio.get_running_loop()

    def release_loop(self) -> None:
        """Forget the captured loop (shutdown/tests); publishes become no-ops."""
        self._loop = None

    # -- subscriptions (event-loop thread only) --------------------------
    def subscribe(self, facility_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAXSIZE)
        self._subs.setdefault(facility_id, set()).add(q)
        return q

    def unsubscribe(self, facility_id: str, q: asyncio.Queue) -> None:
        subs = self._subs.get(facility_id)
        if subs is None:
            return
        subs.discard(q)
        if not subs:
            self._subs.pop(facility_id, None)

    def subscriber_count(self, facility_id: str) -> int:
        return len(self._subs.get(facility_id, ()))

    # -- publishing (any thread) -----------------------------------------
    def publish(self, facility_id: str, event: str, data: Any, id: str | None = None) -> None:
        loop = self._loop
        if loop is None:
            log.debug("SSE publish ignored (no event loop) event=%s", event)
            return
        frame = format_sse(event, data, id)
        try:
            loop.call_soon_threadsafe(self._fanout, facility_id, frame)
        except RuntimeError:
            # Loop already closed (e.g. during shutdown): nothing to deliver to.
            log.debug("SSE publish ignored (event loop closed) event=%s", event)

    def _fanout(self, facility_id: str, frame: str) -> None:
        """Runs on the event loop. A full queue means a stalled client: drop it,
        free one slot and enqueue the close marker so its stream ends (Req 18.4)."""
        subs = self._subs.get(facility_id)
        if not subs:
            return
        for q in list(subs):
            try:
                q.put_nowait(frame)
            except asyncio.QueueFull:
                subs.discard(q)
                try:
                    q.get_nowait()  # free one slot so the close marker fits
                except asyncio.QueueEmpty:
                    pass
                q.put_nowait(_CLOSE)  # cannot raise: one slot was just freed
                log.warning("SSE subscriber dropped (queue full) facility=%s", facility_id)
        if not subs:
            self._subs.pop(facility_id, None)


broker = EventBroker()
