import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./modules/auth", () => ({
  authApi: { refresh: vi.fn() },
}));

vi.mock("./config", () => ({
  getApiAuthMode: vi.fn(() => "multi_user"),
  setAuthToken: vi.fn(),
  clearAuthToken: vi.fn(),
}));

import { setAuthToken } from "./config";
import { authApi } from "./modules/auth";
import {
  adoptAccessSession,
  clearAccessSession,
  ensureAccessSessionFresh,
  refreshAccessSession,
  restoreAccessSession,
} from "./authSession";

describe("authSession", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    vi.clearAllMocks();
    clearAccessSession();
  });

  it("coalesces concurrent refresh requests", async () => {
    let resolveRefresh: (value: {
      token: string;
      username: string;
      access_expires_at: string;
    }) => void = () => undefined;
    vi.mocked(authApi.refresh).mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const first = refreshAccessSession();
    const second = refreshAccessSession();
    resolveRefresh({
      token: "renewed",
      username: "admin",
      access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(authApi.refresh).toHaveBeenCalledOnce();
    expect(setAuthToken).toHaveBeenCalledWith("renewed");
  });

  it("refreshes before a known access token expires", async () => {
    adoptAccessSession({
      token: "short-lived",
      username: "admin",
      access_expires_at: new Date(Date.now() + 20_000).toISOString(),
    });
    vi.mocked(authApi.refresh).mockResolvedValue({
      token: "renewed",
      username: "admin",
      access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });

    await expect(ensureAccessSessionFresh()).resolves.toBe(true);
    expect(authApi.refresh).toHaveBeenCalledOnce();
  });

  it("keeps cross-tab refresh blocked until bootstrap identity verification completes", async () => {
    let queue = Promise.resolve();
    vi.stubGlobal("navigator", { locks: { request: (_name: string, callback: () => Promise<unknown>) => {
      const result = queue.then(callback);
      queue = result.then(() => undefined, () => undefined);
      return result;
    } } });
    vi.mocked(authApi.refresh).mockResolvedValue({ token: "fresh", username: "admin", access_expires_at: new Date(Date.now() + 900_000).toISOString() });
    let finishIdentity: (value: string) => void = () => undefined;
    const identity = vi.fn(() => new Promise<string>((resolve) => { finishIdentity = resolve; }));
    const restoring = restoreAccessSession(identity);
    await vi.waitFor(() => expect(identity).toHaveBeenCalledOnce());
    const refreshing = refreshAccessSession();
    await Promise.resolve();
    expect(authApi.refresh).toHaveBeenCalledOnce();
    finishIdentity("verified");
    expect((await restoring).identity).toBe("verified");
    expect(await refreshing).toBe(true);
    expect(authApi.refresh).toHaveBeenCalledTimes(2);
  });
});
