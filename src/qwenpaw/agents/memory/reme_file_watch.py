"""ReMe watch step using platform-owned, isolated directory subscriptions."""
from contextlib import aclosing
from typing import Any, Callable

from reme.components import R
from reme.steps.index._change_batch import coalesce_changes
from reme.steps.index.watch_changes import WatchChangesStep
from watchfiles import Change

from ...utils.file_watcher import isolated_awatch


@R.register("qwenpaw_watch_changes_step")
class IsolatedMemoryWatchStep(WatchChangesStep):
    """Keep ReMe rules/dispatch semantics without reserving HTTP workers."""

    def __init__(self, awatch_factory: Callable[..., Any] = isolated_awatch, **kwargs):
        super().__init__(**kwargs)
        self._awatch_factory = awatch_factory

    async def execute(self):
        if self.context is None or self.context.stop_event is None:
            raise RuntimeError("qwenpaw_watch_changes_step requires stop_event")
        stop_event = self.context.stop_event
        self._rules = self._get_watch_rules()
        valid_paths = list(
            dict.fromkeys(r.path for r in self._rules if r.path.exists())
        )
        if not valid_paths:
            raise RuntimeError("No valid memory watch paths configured")
        watcher = self._awatch_factory(
            *valid_paths,
            watch_filter=self._filter,
            recursive=self.recursive,
            force_polling=self.force_polling,
            debounce=self.debounce,
            step=self.step,
            poll_delay_ms=self.poll_delay_ms,
            stop_event=stop_event,
        )
        async with aclosing(watcher):
            async for raw_changes in watcher:
                if stop_event.is_set():
                    break
                changes = coalesce_changes(
                    [
                        {"change": change.name, "path": path}
                        for change, path in raw_changes
                        if change in (Change.added, Change.modified, Change.deleted)
                    ]
                )
                if changes:
                    await self.dispatch_steps(self.dispatch_step_specs, changes=changes)
        return self.context.response
