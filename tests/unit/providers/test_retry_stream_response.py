# -*- coding: utf-8 -*-
"""Verify streaming recovery against real AgentScope response frames."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import AsyncGenerator

import pytest
from agentscope.message import TextBlock, ToolCallBlock
from agentscope.model import ChatResponse, ChatUsage

from qwenpaw.providers.rate_limiter import _limiters
from qwenpaw.providers.retry_chat_model import (
    RateLimitConfig,
    RetryChatModel,
    RetryConfig,
)


class _SDKStreamModel:
    stream = True
    context_size = 32768
    parameters = None
    _provider_id = "sdk-response-regression"

    def __init__(
        self,
        name: str,
        factory: Callable[[int], AsyncGenerator[ChatResponse, None]],
    ) -> None:
        self.model = name
        self.factory = factory
        self.calls = 0
        self.closed = 0

    async def __call__(self, *_args, **_kwargs):
        self.calls += 1
        attempt = self.calls

        async def frames():
            stream = self.factory(attempt)
            try:
                async for frame in stream:
                    yield frame
            finally:
                await stream.aclose()
                self.closed += 1

        return frames()


def _wrapper(inner: _SDKStreamModel) -> RetryChatModel:
    return RetryChatModel(
        inner,
        retry_config=RetryConfig(
            max_retries=1,
            backoff_base=0.01,
            backoff_cap=0.01,
        ),
        rate_limit_config=RateLimitConfig(
            max_concurrent=1,
            max_qpm=0,
            jitter_range=0.0,
        ),
    )


@pytest.mark.asyncio
async def test_sdk_text_delta_is_delivered_before_upstream_completion():
    finish = asyncio.Event()
    reached_finish = asyncio.Event()

    async def frames(_attempt):
        yield ChatResponse(
            id="text-response",
            content=[TextBlock(id="text", text="first")],
            is_last=False,
        )
        reached_finish.set()
        await finish.wait()
        yield ChatResponse(
            id="text-response",
            content=[TextBlock(id="text", text="first second")],
            is_last=True,
        )

    inner = _SDKStreamModel("live-text", frames)
    model = _wrapper(inner)
    stream = await model(messages=[])
    try:
        first = await asyncio.wait_for(anext(stream), timeout=1)
        assert first.content[0].text == "first"
        assert first.is_last is False
        assert finish.is_set() is False
        assert reached_finish.is_set() is False

        finish.set()
        remaining = [frame async for frame in stream]
        assert len(remaining) == 1
        assert remaining[0].content[0].text == "first second"
        assert remaining[0].is_last is True
        assert inner.calls == inner.closed == 1
        assert _limiters[model.model_key].stats()["current_in_flight"] == 0
    finally:
        finish.set()
        await stream.aclose()
        _limiters.pop(model.model_key, None)


@pytest.mark.asyncio
async def test_sdk_mutable_tool_frames_keep_deltas_and_final_canonical_frame():
    fragments = ['{"path":"report', '.pdf"}', '{"path":"report.pdf"}']
    shared = ChatResponse(
        id="tool-response",
        content=[ToolCallBlock(id="tool-success", name="read_file", input="")],
        is_last=False,
        metadata={"provider_frame": {"ordinal": 0}},
        usage=ChatUsage(
            input_tokens=10,
            output_tokens=0,
            time=0.5,
            metadata={"details": {"reasoning_tokens": 0}},
        ),
    )

    async def frames(_attempt):
        for index, fragment in enumerate(fragments):
            shared.content[0].input = fragment
            shared.is_last = index == len(fragments) - 1
            shared.metadata["provider_frame"]["ordinal"] = index
            shared.usage.output_tokens = index + 1
            shared.usage.metadata["details"]["reasoning_tokens"] = index
            yield shared
        # A provider can reuse the response object after emitting its final
        # frame. Buffered snapshots must not retain that mutable reference.
        shared.content[0].input = "changed after completion"
        shared.metadata["provider_frame"]["ordinal"] = 999
        shared.usage.output_tokens = 999
        shared.usage.metadata["details"]["reasoning_tokens"] = 999

    inner = _SDKStreamModel("mutable-tool", frames)
    model = _wrapper(inner)
    try:
        stream = await model(messages=[])
        received = [frame async for frame in stream]
        assert [frame.content[0].input for frame in received] == fragments
        assert [frame.is_last for frame in received] == [False, False, True]
        assert [frame.id for frame in received] == ["tool-response"] * 3
        assert [frame.content[0].id for frame in received] == ["tool-success"] * 3
        assert all(frame is not shared for frame in received)
        assert [frame.metadata["provider_frame"]["ordinal"] for frame in received] == [
            0,
            1,
            2,
        ]
        assert [frame.usage.output_tokens for frame in received] == [1, 2, 3]
        assert [
            frame.usage.metadata["details"]["reasoning_tokens"] for frame in received
        ] == [0, 1, 2]
        assert all(frame.usage is not shared.usage for frame in received)
        assert json.loads(received[-1].content[0].input) == {"path": "report.pdf"}
        assert inner.calls == inner.closed == 1
        assert _limiters[model.model_key].stats()["current_in_flight"] == 0
    finally:
        _limiters.pop(model.model_key, None)


@pytest.mark.asyncio
async def test_sdk_retry_discards_failed_tool_id_and_argument_fragments():
    openai = pytest.importorskip("openai")
    fragments = ['{"path":"complete', '.pdf"}', '{"path":"complete.pdf"}']

    async def frames(attempt):
        shared = ChatResponse(
            id=f"response-attempt-{attempt}",
            content=[
                ToolCallBlock(
                    id="failed-tool" if attempt == 1 else "successful-tool",
                    name="read_file",
                    input="",
                )
            ],
            is_last=False,
        )
        if attempt == 1:
            shared.content[0].input = '{"path":"failed'
            yield shared
            raise openai.APIError(
                "stream closed before response.completed",
                request=None,
                body=None,
            )
        for index, fragment in enumerate(fragments):
            shared.content[0].input = fragment
            shared.is_last = index == len(fragments) - 1
            yield shared

    inner = _SDKStreamModel("tool-recovery", frames)
    model = _wrapper(inner)
    try:
        stream = await model(messages=[])
        received = [frame async for frame in stream]
        assert [frame.id for frame in received] == ["response-attempt-2"] * 3
        assert [frame.content[0].id for frame in received] == ["successful-tool"] * 3
        assert [frame.content[0].input for frame in received] == fragments
        assert [frame.is_last for frame in received] == [False, False, True]
        assert json.loads(received[-1].content[0].input) == {"path": "complete.pdf"}
        assert inner.calls == inner.closed == 2
        assert _limiters[model.model_key].stats()["current_in_flight"] == 0
    finally:
        _limiters.pop(model.model_key, None)


@pytest.mark.asyncio
@pytest.mark.parametrize("buffer_tool_frame", [False, True])
async def test_sdk_stream_cancellation_closes_source_and_releases_slot(
    buffer_tool_frame,
):
    waiting = asyncio.Event()
    finish = asyncio.Event()

    async def frames(_attempt):
        if buffer_tool_frame:
            yield ChatResponse(
                content=[
                    ToolCallBlock(id="cancelled-tool", name="read_file", input="{")
                ],
                is_last=False,
            )
        waiting.set()
        await finish.wait()

    inner = _SDKStreamModel(f"cancel-{buffer_tool_frame}", frames)
    model = _wrapper(inner)
    stream = await model(messages=[])

    async def consume():
        return [frame async for frame in stream]

    task = asyncio.create_task(consume())
    try:
        await asyncio.wait_for(waiting.wait(), timeout=1)
        limiter = _limiters[model.model_key]
        assert limiter.stats()["current_in_flight"] == int(not buffer_tool_frame)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert inner.calls == inner.closed == 1
        assert limiter.stats()["current_in_flight"] == 0
        await asyncio.wait_for(limiter.acquire(), timeout=1)
        limiter.release()
        assert limiter.stats()["current_in_flight"] == 0
    finally:
        task.cancel()
        await stream.aclose()
        _limiters.pop(model.model_key, None)
