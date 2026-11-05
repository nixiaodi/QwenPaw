"""ReMe index dispatch remains intact with isolated file watchers."""
import asyncio

import pytest
from reme.components.application_context import ApplicationContext
from reme.steps.index._watch_rules import WatchRule
from watchfiles import Change

from qwenpaw.agents.memory.reme_file_watch import IsolatedMemoryWatchStep
from qwenpaw.agents.memory.reme_root_memory import RootMemoryWatchStep


@pytest.mark.asyncio
async def test_watches_allowed_paths_and_dispatches_coalesced_changes(tmp_path):
    target = tmp_path / "note.md"
    target.write_text("memory", encoding="utf-8")
    stop = asyncio.Event()
    dispatched = []

    class RecordingStep(IsolatedMemoryWatchStep):
        def _get_watch_rules(self):
            return [WatchRule(tmp_path, ["md"])]

        async def dispatch_steps(self, _steps, **kwargs):
            dispatched.extend(kwargs["changes"])

    async def source(*paths, **kwargs):
        assert paths == (tmp_path,)
        assert kwargs["stop_event"] is stop
        assert kwargs["watch_filter"](Change.modified, str(target))
        assert not kwargs["watch_filter"](Change.added, str(tmp_path / "secret.json"))
        yield {(Change.added, str(target)), (Change.modified, str(target))}
        stop.set()
        yield {(Change.deleted, str(target))}

    step = RecordingStep(
        app_context=ApplicationContext(workspace_dir=str(tmp_path)),
        dispatch_steps=["update_index_step"],
        awatch_factory=source,
    )
    await step(stop_event=stop)
    assert dispatched == [{"change": "modified", "path": str(target)}]


@pytest.mark.asyncio
@pytest.mark.parametrize("base_class", [IsolatedMemoryWatchStep, RootMemoryWatchStep])
@pytest.mark.parametrize("cancel", [False, True])
async def test_dispatch_failure_closes_watcher_before_job_returns(
    tmp_path, base_class, cancel
):
    closed = asyncio.Event()
    dispatching = asyncio.Event()
    target = tmp_path / "MEMORY.md"

    async def source():
        try:
            yield {(Change.modified, str(target))}
        finally:
            closed.set()

    # Retain a reference so garbage collection cannot mask missing cleanup.
    watcher = source()

    class FailingStep(base_class):
        def _get_watch_rules(self):
            return [WatchRule(tmp_path, ["md"])]

        async def dispatch_steps(self, _steps, **kwargs):
            dispatching.set()
            if cancel:
                await asyncio.Event().wait()
            raise RuntimeError("index update failed")

    step = FailingStep(
        app_context=ApplicationContext(workspace_dir=str(tmp_path)),
        dispatch_steps=["update_index_step"],
        awatch_factory=lambda *args, **kwargs: watcher,
    )
    task = asyncio.create_task(step(stop_event=asyncio.Event()))
    try:
        await asyncio.wait_for(dispatching.wait(), 2)
        if cancel:
            task.cancel()
        with pytest.raises(asyncio.CancelledError if cancel else RuntimeError):
            await task
        assert closed.is_set()
    finally:
        await watcher.aclose()
