"""Directory watching must not reserve the web server's AnyIO workers."""
import asyncio
import threading

import anyio
import pytest
from watchfiles import Change

from qwenpaw.utils.file_watcher import isolated_awatch


@pytest.mark.asyncio
async def test_many_watchers_leave_shared_workers_available(tmp_path):
    limiter = anyio.to_thread.current_default_thread_limiter()
    original = limiter.total_tokens
    limiter.total_tokens = 2
    stop = asyncio.Event()
    ready = [asyncio.Event() for _ in range(4)]

    async def consume(index):
        async for _ in isolated_awatch(
            tmp_path,
            stop_event=stop,
            force_polling=True,
            step=20,
            rust_timeout=40,
            yield_on_timeout=True,
        ):
            ready[index].set()

    tasks = [asyncio.create_task(consume(i)) for i in range(4)]
    try:
        await asyncio.wait_for(asyncio.gather(*(e.wait() for e in ready)), 5)
        assert limiter.borrowed_tokens == 0
        assert await asyncio.wait_for(anyio.to_thread.run_sync(lambda: 42), 0.5) == 42
    finally:
        stop.set()
        await asyncio.wait_for(asyncio.gather(*tasks), 5)
        limiter.total_tokens = original


@pytest.mark.asyncio
async def test_delivers_changes_and_stop_joins_worker(tmp_path):
    stop = asyncio.Event()
    ready = asyncio.Event()
    changed = asyncio.Event()
    target = tmp_path / "MEMORY.md"

    async def consume():
        async for changes in isolated_awatch(
            tmp_path,
            stop_event=stop,
            force_polling=True,
            step=20,
            debounce=30,
            poll_delay_ms=20,
            rust_timeout=40,
            yield_on_timeout=True,
        ):
            ready.set()
            if any(
                path == str(target) and kind in (Change.added, Change.modified)
                for kind, path in changes
            ):
                changed.set()

    task = asyncio.create_task(consume())
    try:
        await asyncio.wait_for(ready.wait(), 5)
        target.write_text("memory", encoding="utf-8")
        await asyncio.wait_for(changed.wait(), 5)
    finally:
        stop.set()
        await asyncio.wait_for(task, 5)
    await asyncio.sleep(0.05)
    assert not any(t.name.startswith("qwenpaw-watch") for t in threading.enumerate())


@pytest.mark.asyncio
async def test_cancel_and_missing_path_do_not_leak_workers(tmp_path):
    iterator = isolated_awatch(tmp_path, step=20, rust_timeout=1000)
    task = asyncio.create_task(anext(iterator))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 3)
    await iterator.aclose()
    with pytest.raises(FileNotFoundError):
        await anext(isolated_awatch(tmp_path / "missing"))
    await asyncio.sleep(0.05)
    assert not any(t.name.startswith("qwenpaw-watch") for t in threading.enumerate())
