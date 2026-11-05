"""File watching isolated from AnyIO's shared HTTP/file-serving workers."""
from __future__ import annotations

import asyncio
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, AsyncIterator

import anyio
from watchfiles import Change, watch


async def isolated_awatch(
    *paths: str | Path,
    stop_event: asyncio.Event | None = None,
    rust_timeout: int | None = None,
    **kwargs: Any,
) -> AsyncIterator[set[tuple[Change, str]]]:
    """Wait on one private worker per subscription, never on the HTTP pool.

    Pulling one batch at a time preserves watchfiles' backpressure and bounds
    memory while the consumer updates an index. Closing/cancelling the async
    iterator stops the native watcher and joins its worker before returning.
    """
    if stop_event is not None and stop_event.is_set():
        return
    loop = asyncio.get_running_loop()
    thread_stop = threading.Event()
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="qwenpaw-watch")
    iterator = watch(
        *paths,
        stop_event=thread_stop,
        rust_timeout=(1000 if sys.platform == "win32" else 5000)
        if rust_timeout is None
        else rust_timeout,
        raise_interrupt=False,
        **kwargs,
    )
    sentinel = object()
    stop_waiter = (
        asyncio.create_task(stop_event.wait()) if stop_event is not None else None
    )
    pending = None
    try:
        while not thread_stop.is_set():
            pending = loop.run_in_executor(executor, next, iterator, sentinel)
            if stop_waiter is not None:
                await asyncio.wait(
                    (pending, stop_waiter), return_when=asyncio.FIRST_COMPLETED
                )
                if stop_waiter.done():
                    break
            batch = await asyncio.shield(pending)
            pending = None
            if batch is sentinel:
                break
            yield batch
    finally:
        thread_stop.set()
        # ASGI task groups may repeatedly cancel awaits during disconnect.
        # Shield only cleanup, so native watchers cannot outlive their owner.
        with anyio.CancelScope(shield=True):
            if stop_waiter is not None:
                stop_waiter.cancel()
                await asyncio.gather(stop_waiter, return_exceptions=True)
            if pending is not None:
                try:
                    await asyncio.shield(pending)
                except Exception:
                    pass  # Preserve the original error/cancellation.
            try:
                await asyncio.shield(loop.run_in_executor(executor, iterator.close))
            finally:
                executor.shutdown(wait=True)
