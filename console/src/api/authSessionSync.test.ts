import { afterEach, expect, it, vi } from "vitest";
import {
  withSessionRefreshLock,
  createSessionChannel,
} from "./authSessionSync";

afterEach(() => vi.unstubAllGlobals());

it("serializes refreshes across tabs through the origin lock", async () => {
  const request = vi.fn(async (_name, callback) => callback());
  vi.stubGlobal("navigator", { locks: { request } });
  const refresh = vi.fn(async () => true);
  expect(await withSessionRefreshLock(refresh)).toBe(true);
  expect(request).toHaveBeenCalledWith(
    "qwenpaw-session-refresh",
    expect.any(Function),
  );
});

it("receives cross-tab invalidation without storing access tokens", () => {
  let instance: { onmessage?: (event: { data: unknown }) => void };
  const postMessage = vi.fn();
  const close = vi.fn();
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage?: (event: { data: unknown }) => void;
      postMessage = postMessage;
      close = close;
      constructor() {
        instance = this;
      }
    },
  );
  const received = vi.fn();
  const channel = createSessionChannel(received);
  instance!.onmessage!({ data: { type: "cleared" } });
  expect(received).toHaveBeenCalledWith({ type: "cleared" });
  channel.publish({ type: "cleared" });
  expect(postMessage).toHaveBeenCalledWith({ type: "cleared" });
  expect(localStorage.getItem("qwenpaw_auth_token")).toBeNull();
  channel.close();
  expect(close).toHaveBeenCalledOnce();
});
