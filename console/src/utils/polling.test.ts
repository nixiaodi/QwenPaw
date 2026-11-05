import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { schedulePolling } from "./polling";

let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  stop?.();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("waits for a slow request and aborts it on teardown", async () => {
  let signal!: AbortSignal;
  let finish!: () => void;
  const task = vi.fn((s: AbortSignal) => {
    signal = s;
    return new Promise<void>((r) => {
      finish = r;
    });
  });
  stop = schedulePolling(task, { intervalMs: 1000 });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(task).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(999);
  expect(task).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(task).toHaveBeenCalledTimes(2);
  stop();
  expect(signal.aborted).toBe(true);
  finish();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(task).toHaveBeenCalledTimes(2);
});

it("pauses hidden/offline lists and refreshes on return", async () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const task = vi.fn().mockResolvedValue(undefined);
  stop = schedulePolling(task, { intervalMs: 1000 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(task).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(task).toHaveBeenCalledTimes(1);
  online.mockReturnValue(false);
  window.dispatchEvent(new Event("offline"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(task).toHaveBeenCalledTimes(1);
  online.mockReturnValue(true);
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(0);
  expect(task).toHaveBeenCalledTimes(2);
});

it("keeps background notifications at a slower cadence", async () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const task = vi.fn().mockResolvedValue(undefined);
  stop = schedulePolling(task, { intervalMs: 2500, hiddenIntervalMs: 30_000 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(task).toHaveBeenCalledTimes(2);
});

it("backs off failures and returns to the normal interval after success", async () => {
  const task = vi
    .fn()
    .mockRejectedValueOnce(new Error("503"))
    .mockRejectedValueOnce(new Error("503"))
    .mockResolvedValue(undefined);
  stop = schedulePolling(task, { intervalMs: 1000 });
  await vi.advanceTimersByTimeAsync(5999);
  expect(task).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(task).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1000);
  expect(task).toHaveBeenCalledTimes(4);
});
