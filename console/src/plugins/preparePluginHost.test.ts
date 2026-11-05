import { afterEach, beforeEach, expect, it, vi } from "vitest";
const host = vi.hoisted(() => ({
  externals: vi.fn(),
  sdk: vi.fn(),
  ready: Promise.resolve() as Promise<void>,
}));
vi.mock("./hostExternals", async () => {
  await host.ready;
  return { installHostExternals: host.externals };
});
vi.mock("./hostSdk/install", () => ({ installHostSdk: host.sdk }));
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  host.externals.mockReset();
  host.sdk.mockReset();
  host.ready = Promise.resolve();
});
afterEach(() => vi.useRealTimers());

it("initializes complete externals once, before the SDK, for concurrent callers", async () => {
  const { preparePluginHost } = await import("./preparePluginHost");
  expect(host.externals).not.toHaveBeenCalled();
  await Promise.all([preparePluginHost(), preparePluginHost()]);
  expect(host.externals).toHaveBeenCalledTimes(1);
  expect(host.sdk).toHaveBeenCalledTimes(1);
  expect(host.externals.mock.invocationCallOrder[0]).toBeLessThan(
    host.sdk.mock.invocationCallOrder[0],
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("does not begin initialization for an already cancelled identity", async () => {
  const { preparePluginHost } = await import("./preparePluginHost");
  const controller = new AbortController();
  controller.abort();
  await expect(preparePluginHost(controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(host.externals).not.toHaveBeenCalled();
});

it("does not start dependencies after the preparation budget is exhausted", async () => {
  const { preparePluginHost } = await import("./preparePluginHost");
  await expect(preparePluginHost(undefined, 0)).rejects.toThrow("timed out");
  expect(host.externals).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("allows a later attempt after a host installation error", async () => {
  host.externals.mockImplementationOnce(() => {
    throw new Error("install failed");
  });
  const { preparePluginHost } = await import("./preparePluginHost");
  await expect(preparePluginHost()).rejects.toThrow("install failed");
  await preparePluginHost();
  expect(host.sdk).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
