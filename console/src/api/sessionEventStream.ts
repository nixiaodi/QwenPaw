import { getApiUrl } from "./config";
import { buildAuthHeaders } from "./authHeaders";
import {
  getAccessSessionGeneration,
  subscribeAccessSessionGeneration,
} from "./authSession";

export interface SessionStreamOptions {
  agentId?: string;
  onConnectionChange?: (connected: boolean) => void;
}

/** Shared lifecycle for session status streams; EOF is a disconnect too. */
export function subscribeSessionEvents<T extends { type: string }>(
  path: string,
  onEvent: (event: T) => void,
  onError?: (error: unknown) => void,
  options: SessionStreamOptions = {},
): () => void {
  const generation = getAccessSessionGeneration();
  const agentId = options.agentId ?? buildAuthHeaders()["X-Agent-Id"];
  let stopped = false;
  let running = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt: AbortController | undefined;
  const available = () =>
    !stopped &&
    navigator.onLine !== false &&
    generation === getAccessSessionGeneration();

  async function connect() {
    if (running || !available()) return;
    running = true;
    const controller = new AbortController();
    attempt = controller;
    const openingTimer = setTimeout(() => controller.abort(), 15_000);
    const started = Date.now();
    let receivedEvent = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(getApiUrl(path), {
        headers: {
          ...buildAuthHeaders(),
          ...(agentId ? { "X-Agent-Id": agentId } : {}),
        },
        signal: controller.signal,
      });
      clearTimeout(openingTimer);
      if (controller.signal.aborted || !available()) return;
      if (!response.ok || !response.body)
        throw new Error(`SSE connect failed: ${response.status}`);
      reader = response.body.getReader();
      options.onConnectionChange?.(true);
      const decoder = new TextDecoder();
      let buffer = "";
      let data: string[] = [];
      const flush = () => {
        if (data.length === 0) return;
        const text = data.join("\n");
        data = [];
        let event: unknown;
        try {
          event = JSON.parse(text);
        } catch {
          return;
        }
        if (
          !event ||
          typeof event !== "object" ||
          !("type" in event) ||
          typeof event.type !== "string"
        )
          return;
        if (!controller.signal.aborted && available()) {
          receivedEvent = true;
          onEvent(event as T);
        }
      };
      const line = (value: string) => {
        const text = value.replace(/\r$/, "");
        if (!text) flush();
        else if (text.startsWith("data:"))
          data.push(text.slice(5).replace(/^ /, ""));
      };
      while (!controller.signal.aborted && available()) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer) line(buffer);
          flush();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        lines.forEach(line);
      }
      if (available() && !controller.signal.aborted)
        throw new Error("SSE stream ended");
    } catch (error) {
      if (available()) onError?.(error);
    } finally {
      clearTimeout(openingTimer);
      controller.abort();
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      attempt = undefined;
      running = false;
      if (!stopped) options.onConnectionChange?.(false);
      // An empty 200 response must not reset the backoff on every reconnect.
      if (receivedEvent || Date.now() - started >= 30_000) failures = 0;
      const delay = Math.min(30_000, 3000 * 2 ** failures);
      failures = Math.min(failures + 1, 4);
      if (available()) timer = setTimeout(() => void connect(), delay);
    }
  }

  const onAvailability = () => {
    clearTimeout(timer);
    if (navigator.onLine === false) attempt?.abort();
    else void connect();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    attempt?.abort();
    window.removeEventListener("online", onAvailability);
    window.removeEventListener("offline", onAvailability);
    unsubscribeAuth();
  };
  const unsubscribeAuth = subscribeAccessSessionGeneration(stop);
  window.addEventListener("online", onAvailability);
  window.addEventListener("offline", onAvailability);
  void connect();
  return stop;
}
