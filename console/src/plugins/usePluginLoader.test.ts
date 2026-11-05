import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadAllPlugins } from "./usePluginLoader";
import { preparePluginHost } from "./preparePluginHost";

vi.mock("./pluginSystem", () => ({ pluginSystem: { remove: vi.fn() } }));
vi.mock("./preparePluginHost", () => ({
  preparePluginHost: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./registry/chatExtensions", () => ({
  chatExtensions: { disposeAll: vi.fn() },
}));
vi.mock("./registry/store", () => ({
  menuRegistry: { disposeSource: vi.fn() },
  routeRegistry: { disposeSource: vi.fn() },
  slotRegistry: { disposeSource: vi.fn() },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(preparePluginHost).mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("releases application startup when the plugin list never responds", async () => {
  const completed = vi.fn();
  const loading = loadAllPlugins().then(completed);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(completed).toHaveBeenCalledTimes(1);
  expect(completed.mock.calls[0][0].failed.length).toBeGreaterThan(0);
  await loading;
});

it("cancels the previous user's outstanding plugin request", async () => {
  const controller = new AbortController();
  const loading = loadAllPlugins(controller.signal);
  controller.abort();
  const result = await loading;
  expect(result.failed).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("loads an empty plugin list without waiting for the timeout", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response("[]", { status: 200 }));
  expect(await loadAllPlugins()).toEqual({ loaded: 0, failed: [] });
  expect(vi.getTimerCount()).toBe(0);
  expect(preparePluginHost).not.toHaveBeenCalled();
});

it("does not prepare frontend dependencies for backend-only plugins", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify([{ id: "backend", name: "Backend" }]), {
      status: 200,
    }),
  );
  expect(await loadAllPlugins()).toEqual({ loaded: 0, failed: [] });
  expect(preparePluginHost).not.toHaveBeenCalled();
});

it("blocks legacy bundles before downloading or executing code", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(
      JSON.stringify([
        { id: "frontend", name: "Frontend", frontend_entry: "index.js" },
      ]),
    ),
  );
  const result = await loadAllPlugins();
  expect(result.loaded).toBe(0);
  expect(result.failed[0]).toContain("需要升级到 worker-v1");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(preparePluginHost).not.toHaveBeenCalled();
});

it("does not fall back to main-thread execution when Workers are unavailable", async () => {
  vi.stubGlobal("Worker", undefined);
  vi.mocked(fetch)
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: "frontend",
            name: "Frontend",
            frontend_entry: "index.js",
            frontend_runtime: "worker-v1",
          },
        ]),
      ),
    )
    .mockResolvedValueOnce(new Response("globalThis.__unsafePluginRan = true"));
  const result = await loadAllPlugins();
  expect(result.loaded).toBe(0);
  expect(result.failed).toHaveLength(1);
  expect(
    (globalThis as Record<string, unknown>).__unsafePluginRan,
  ).toBeUndefined();
  expect(preparePluginHost).not.toHaveBeenCalled();
});
