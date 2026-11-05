import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginWorkerClient } from "./workerClient";
import { validateView } from "./protocol";

vi.mock("../../api/request", () => ({ request: vi.fn() }));
vi.mock("../../stores/chatSessionScope", () => ({
  getAgentAccessScopeKey: () => "user-agent",
  subscribeChatSessionScope: () => () => {},
}));
vi.mock("../../stores/agentStore", () => ({
  useAgentStore: { getState: () => ({ selectedAgent: "a" }) },
}));
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
  send(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("terminates initialization that never completes instead of merely ending the wait", async () => {
  const client = new PluginWorkerClient("demo", "await new Promise(()=>{})");
  const rejected = expect(client.ready).rejects.toThrow(
    "initialization_timed_out",
  );
  await vi.advanceTimersByTimeAsync(8001);
  await rejected;
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("terminates the old identity and ignores late ready messages", async () => {
  const controller = new AbortController();
  const client = new PluginWorkerClient("demo", "", controller.signal);
  const worker = FakeWorker.instances[0];
  const oldHandler = worker.onmessage!;
  const rejected = expect(client.ready).rejects.toThrow("identity_changed");
  controller.abort();
  oldHandler({ data: { type: "ready", registrations: [] } } as MessageEvent);
  await rejected;
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects attempts to register a core application route", async () => {
  const client = new PluginWorkerClient("demo", "");
  const rejected = expect(client.ready).rejects.toThrow("invalid_plugin_route");
  FakeWorker.instances[0].send({
    type: "ready",
    registrations: [
      { id: "login", kind: "route", path: "/login", label: "bad" },
    ],
  });
  await rejected;
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
});

it("terminates a stuck render and rejects all pending views", async () => {
  const client = new PluginWorkerClient("demo", "");
  FakeWorker.instances[0].send({ type: "ready", registrations: [] });
  await client.ready;
  const rejected = expect(client.render("view", {})).rejects.toThrow(
    "render_timed_out",
  );
  await vi.advanceTimersByTimeAsync(5001);
  await rejected;
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects executable HTML and oversized view trees", () => {
  expect(() => validateView({ tag: "script", text: "alert(1)" })).toThrow(
    "invalid_plugin_tag",
  );
  expect(() =>
    validateView({ tag: "div", children: Array(1001).fill("x") }),
  ).toThrow("too_large");
  expect(
    validateView({
      tag: "button",
      text: "确认",
      action: "submit",
      onClick: "evil",
      dangerouslySetInnerHTML: { __html: "evil" },
    }),
  ).toEqual({ tag: "button", text: "确认", action: "submit" });
});
