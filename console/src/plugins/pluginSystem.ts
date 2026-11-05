import type React from "react";

// The existing plugin ABI accepts components with arbitrary props.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolRenderers = Record<string, React.FC<any>>;

export interface PluginRouteDeclaration {
  /** Full URL path, e.g. "/plugin/my-plugin/dashboard". */
  path: string;
  component: React.ComponentType;
  /** Sidebar display label. */
  label: string;
  /** Emoji or short icon text. */
  icon?: string;
  /** Lower number = appears earlier in sidebar. Defaults to 0. */
  priority?: number;
}

/** Internal per-plugin registration record. */
export interface PluginRegistration {
  pluginId: string;
  /** When true, this plugin's tool renderers are treated as fallback defaults.
   *  External (non-builtin) renderers for the same tool name take priority. */
  isBuiltin: boolean;
  routes: PluginRouteDeclaration[];
  toolRenderers: ToolRenderers;
}

// ─────────────────────────────────────────────────────────────────────────────
// PluginSystem — reactive singleton
// ─────────────────────────────────────────────────────────────────────────────

class PluginSystem {
  private records = new Map<string, PluginRegistration>();
  private listeners = new Set<() => void>();

  // ── Write API ───────────────────────────────────────────────────────────

  addRoutes(pluginId: string, routes: PluginRouteDeclaration[]): void {
    const rec = this._record(pluginId);
    rec.routes.push(...routes);
    this._notify();
  }

  addToolRenderers(
    pluginId: string,
    renderers: ToolRenderers,
    options?: { isBuiltin?: boolean },
  ): void {
    const rec = this._record(pluginId);
    if (options?.isBuiltin) rec.isBuiltin = true;
    Object.assign(rec.toolRenderers, renderers);
    this._notify();
  }

  remove(pluginId: string): void {
    if (this.records.delete(pluginId)) this._notify();
  }

  // ── Read API (consumed by PluginContext / usePlugins) ────────────────────

  /** Merged map of all tool renderers across all plugins.
   *  Builtin renderers are applied first, then external plugin renderers
   *  overlay on top — so external plugins take priority over builtins. */
  getToolRenderConfig(): ToolRenderers {
    const builtinRenderers: ToolRenderers = {};
    const externalRenderers: ToolRenderers = {};
    for (const rec of this.records.values()) {
      const target = rec.isBuiltin ? builtinRenderers : externalRenderers;
      Object.assign(target, rec.toolRenderers);
    }
    return { ...builtinRenderers, ...externalRenderers };
  }

  /** Flat list of all page routes across all plugins, sorted by priority. */
  getRoutes(): PluginRouteDeclaration[] {
    const out: PluginRouteDeclaration[] = [];
    for (const rec of this.records.values()) out.push(...rec.routes);
    return out.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  }

  // ── Subscription ─────────────────────────────────────────────────────────

  /** Subscribe to any registration change. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _record(pluginId: string): PluginRegistration {
    if (!this.records.has(pluginId)) {
      this.records.set(pluginId, {
        pluginId,
        isBuiltin: false,
        routes: [],
        toolRenderers: {},
      });
    }
    return this.records.get(pluginId)!;
  }

  private _notify(): void {
    this.listeners.forEach((fn) => fn());
  }
}

/** Global singleton — imported by PluginContext to subscribe to changes. */
export const pluginSystem = new PluginSystem();
