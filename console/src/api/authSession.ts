import { clearAuthToken, getApiAuthMode, setAuthToken } from "./config";
import { authApi, type LoginResponse } from "./modules/auth";
import {
  createSessionChannel,
  withSessionRefreshLock,
} from "./authSessionSync";

const REFRESH_MARGIN_MS = 60_000;

let accessExpiresAt = 0;
let refreshPromise: Promise<boolean> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let sessionGeneration = 0;
let sessionUserId = "";
const generationListeners = new Set<() => void>();
const sessionListeners = new Set<(session: LoginResponse) => void>();

export function subscribeAccessSessionUpdates(
  listener: (session: LoginResponse) => void,
) {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}
let sessionChannel: ReturnType<typeof createSessionChannel> | null = null;

function getSessionChannel() {
  if (!sessionChannel)
    sessionChannel = createSessionChannel((event) => {
      if (getApiAuthMode() !== "multi_user") return;
      if (event.type === "cleared") clearAccessSession(false);
      else adoptAccessSession(event.session, false);
    });
  return sessionChannel;
}

export const getAccessSessionGeneration = () => sessionGeneration;
export function subscribeAccessSessionGeneration(listener: () => void) {
  generationListeners.add(listener);
  return () => {
    generationListeners.delete(listener);
  };
}

function parseExpiresAt(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cancelRefreshTimer(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleRefresh(): void {
  cancelRefreshTimer();
  if (getApiAuthMode() !== "multi_user" || accessExpiresAt === 0) return;
  const delay = Math.max(0, accessExpiresAt - Date.now() - REFRESH_MARGIN_MS);
  refreshTimer = setTimeout(() => {
    void refreshAccessSession();
  }, delay);
}

export function adoptAccessSession(
  response: LoginResponse,
  broadcast = true,
): void {
  if (
    sessionUserId &&
    response.user?.id &&
    sessionUserId !== response.user.id
  ) {
    clearAccessSession(false);
  }
  sessionUserId = response.user?.id ?? sessionUserId;
  setAuthToken(response.token);
  accessExpiresAt = parseExpiresAt(response.access_expires_at);
  scheduleRefresh();
  sessionListeners.forEach((listener) => listener(response));
  if (broadcast && getApiAuthMode() === "multi_user")
    getSessionChannel().publish({ type: "renewed", session: response });
}

export function clearAccessSession(broadcast = true): void {
  sessionUserId = "";
  sessionGeneration += 1;
  generationListeners.forEach((listener) => listener());
  accessExpiresAt = 0;
  refreshPromise = null;
  cancelRefreshTimer();
  clearAuthToken();
  if (broadcast && getApiAuthMode() === "multi_user")
    getSessionChannel().publish({ type: "cleared" });
}

export async function refreshAccessSession(): Promise<boolean> {
  if (getApiAuthMode() !== "multi_user") return false;
  if (refreshPromise) return refreshPromise;

  const generation = sessionGeneration;
  getSessionChannel();
  const currentPromise = withSessionRefreshLock(() => {
    if (generation !== sessionGeneration)
      throw new Error("Authentication context changed");
    return authApi.refresh();
  })
    .then((response) => {
      if (generation !== sessionGeneration) return false;
      adoptAccessSession(response);
      return true;
    })
    .catch(() => false)
    .finally(() => {
      if (refreshPromise === currentPromise) refreshPromise = null;
    });
  refreshPromise = currentPromise;
  return currentPromise;
}

export function restoreAccessSession<T>(identify: () => Promise<T>) {
  getSessionChannel();
  const generation = sessionGeneration;
  return withSessionRefreshLock(async () => {
    if (generation !== sessionGeneration)
      throw new Error("Authentication context changed");
    const response = await authApi.refresh();
    if (generation !== sessionGeneration)
      throw new Error("Authentication context changed");
    adoptAccessSession(response);
    // Keep identity verification inside the same origin lock: another tab's
    // rotation must not invalidate this access token before /me completes.
    const identity = await identify();
    return { response, identity };
  });
}

export async function ensureAccessSessionFresh(): Promise<boolean> {
  if (getApiAuthMode() !== "multi_user") return true;
  if (accessExpiresAt === 0) return true;
  if (accessExpiresAt - Date.now() > REFRESH_MARGIN_MS) return true;
  return refreshAccessSession();
}
