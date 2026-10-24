"""Event broker and SSE framing (Requirements 18.2–18.4, 18.10, 44.5).

Each test uses its own ``EventBroker`` and drives the loop with ``asyncio.run``
(no async pytest plugin is installed).
"""
from __future__ import annotations

import asyncio
import json
import logging
import threading

from app import events
from app.events import QUEUE_MAXSIZE, EventBroker, format_sse

FAC = "fac-1"


# --------------------------------------------------------------------------- format_sse


def test_format_sse_with_id_and_event():
    frame = format_sse("alert.created", {"a": 1, "b": "x y"}, id="7")
    assert frame == 'id: 7\nevent: alert.created\ndata: {"a":1,"b":"x y"}\n\n'


def test_format_sse_data_only_and_single_line_json():
    frame = format_sse(None, {"reason": "line1\nline2", "sym": "≥160"})
    assert frame.startswith("data: ") and frame.endswith("\n\n")
    lines = frame[:-2].split("\n")
    assert len(lines) == 1  # string newlines are JSON-escaped, never raw
    assert json.loads(lines[0][len("data: "):]) == {"reason": "line1\nline2", "sym": "≥160"}
    assert "≥160" in frame  # compact, non-ASCII kept


# --------------------------------------------------------------------------- publish


def test_publish_without_loop_is_ignored(caplog):
    caplog.set_level(logging.DEBUG, logger="app.events")
    EventBroker().publish(FAC, "risk.changed", {"x": 1})  # must not raise
    assert any("ignored" in r.getMessage() for r in caplog.records)


def test_cross_thread_publish_reaches_asyncio_subscriber():
    async def scenario():
        broker = EventBroker()
        broker.capture_loop()
        q = broker.subscribe(FAC)
        other = broker.subscribe("fac-2")

        t = threading.Thread(
            target=broker.publish, args=(FAC, "risk.changed", {"mother_id": "m1"}), kwargs={"id": "3"}
        )
        t.start()
        t.join()
        frame = await asyncio.wait_for(q.get(), timeout=2)
        await asyncio.sleep(0)
        broker.release_loop()
        return frame, other.qsize()

    frame, other_size = asyncio.run(scenario())
    assert frame == format_sse("risk.changed", {"mother_id": "m1"}, id="3")
    assert other_size == 0  # per-facility fan-out


def test_full_queue_drops_subscriber_and_delivers_close_marker(caplog):
    caplog.set_level(logging.WARNING, logger="app.events")

    async def scenario():
        broker = EventBroker()
        broker.capture_loop()
        slow = broker.subscribe(FAC)
        for i in range(QUEUE_MAXSIZE + 1):
            broker.publish(FAC, "tick", {"i": i})
        for _ in range(5):
            await asyncio.sleep(0)  # let the scheduled fan-outs run
        count = broker.subscriber_count(FAC)
        items = [slow.get_nowait() for _ in range(slow.qsize())]
        broker.release_loop()
        return count, items

    count, items = asyncio.run(scenario())
    assert count == 0
    assert len(items) == QUEUE_MAXSIZE
    assert items[-1] is events._CLOSE  # noqa: SLF001
    assert items[0] == format_sse("tick", {"i": 1})  # one queued item was dropped
    assert any("dropped" in r.getMessage() for r in caplog.records)
