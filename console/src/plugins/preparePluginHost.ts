let preparation: Promise<void> | undefined;

/** Keep complete dependency namespaces off the anonymous login dependency graph. */
export function preparePluginHost(
  signal?: AbortSignal,
  timeoutMs = 8000,
): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  if (timeoutMs <= 0)
    return Promise.reject(new Error("Plugin host initialization timed out"));
  preparation ??= Promise.all([
    import("./hostExternals"),
    import("./hostSdk/install"),
  ])
    .then(([externals, sdk]) => {
      externals.installHostExternals();
      sdk.installHostSdk();
    })
    .catch((error) => {
      preparation = undefined;
      throw error;
    });

  // Importing trusted host modules cannot be aborted; callers can stop waiting.
  // No user plugin code is executed until this wait succeeds for its identity.
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (failed: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failed) reject(error);
      else resolve();
    };
    const abort = () => finish(true, new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(
      () => finish(true, new Error("Plugin host initialization timed out")),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    preparation!.then(
      () => finish(false),
      (error) => finish(true, error),
    );
  });
}
