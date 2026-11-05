import { afterEach, expect, it, vi } from "vitest";
import { subscribeToolCallStream } from "./toolCalls";

afterEach(() => vi.unstubAllGlobals());

it("falls back to status checks when the stream ends without a done event", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response('data: {"type":"chunk","data":"partial"}\n\n'),
      ),
  );
  const handlers = { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() };
  const stop = subscribeToolCallStream("session", "tool", handlers);
  await vi.waitFor(() => expect(handlers.onChunk).toHaveBeenCalledTimes(1));
  expect(handlers.onDone).not.toHaveBeenCalled();
  expect(handlers.onError).toHaveBeenCalledTimes(1);
  stop();
});

it("still completes normally on an explicit done event", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response('data: {"type":"done"}\n\n')),
  );
  const handlers = { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() };
  const stop = subscribeToolCallStream("session", "tool", handlers);
  await vi.waitFor(() => expect(handlers.onDone).toHaveBeenCalledTimes(1));
  expect(handlers.onError).not.toHaveBeenCalled();
  stop();
});
