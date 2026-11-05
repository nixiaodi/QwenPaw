import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OWNERSHIP_RETRY_MS, useQueueOwnership } from "./useQueueOwnership";
import { useMessageQueueStore } from "../../../stores/messageQueueStore";

const original = Object.getOwnPropertyDescriptor(navigator, "locks");
let held: Set<string>;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  held = new Set();
  request = vi.fn(async (key: string, _options, callback) => {
    if (held.has(key)) return callback(null);
    held.add(key);
    try {
      return await callback({ name: key });
    } finally {
      held.delete(key);
    }
  });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request },
  });
  useMessageQueueStore.setState({
    queues: {},
    runStates: {},
    currentSendingId: null,
  });
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    await Promise.resolve();
  });
  vi.useRealTimers();
  if (original) Object.defineProperty(navigator, "locks", original);
  else Reflect.deleteProperty(navigator, "locks");
});

describe("queue ownership recovery", () => {
  it("recovers a single-tab lock error without losing its queued input", async () => {
    request.mockRejectedValueOnce(new DOMException("blocked", "SecurityError"));
    useMessageQueueStore.getState().enqueue("chat", { text: "pending input" });
    const { result } = renderHook(() =>
      useQueueOwnership("chat", "user:agent"),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("error");
    expect(held.size).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWNERSHIP_RETRY_MS);
    });
    expect(result.current.isOwner).toBe(true);
    expect(useMessageQueueStore.getState().getQueue("chat")).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps one sender across two views and hands over after owner cleanup", async () => {
    const first = renderHook(() => useQueueOwnership("chat", "user:agent"));
    const second = renderHook(() => useQueueOwnership("chat", "user:agent"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(first.result.current.isOwner).toBe(true);
    expect(second.result.current.status).toBe("other-owner");
    await act(async () => {
      first.unmount();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OWNERSHIP_RETRY_MS);
    });
    expect(second.result.current.isOwner).toBe(true);
    expect(held.size).toBe(1);
  });

  it("cancels stale retries on conversation or identity changes and unmount", async () => {
    request.mockRejectedValueOnce(new Error("unavailable"));
    const view = renderHook(({ id, owner }) => useQueueOwnership(id, owner), {
      initialProps: { id: "a", owner: "u:a" },
    });
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender({ id: "b", owner: "v:b" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.result.current.isOwner).toBe(true);
    expect(held.has("qwenpaw:queue-owner:a")).toBe(false);
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * OWNERSHIP_RETRY_MS);
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(held.size).toBe(0);
  });

  it("does not claim ownership for a read-only view", async () => {
    const view = renderHook(() => useQueueOwnership("chat", "viewer", false));
    await act(async () => {
      await Promise.resolve();
    });
    expect(request).not.toHaveBeenCalled();
    expect(view.result.current.isOwner).toBe(false);
  });
});
