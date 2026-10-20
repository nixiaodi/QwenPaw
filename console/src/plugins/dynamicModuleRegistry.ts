import { moduleRegistry } from "./moduleRegistry";

/**
 * Register a namespace only after its page has been imported. Existing exports
 * may have been patched by a plugin, so retain both their values and the module
 * object held by the plugin. An eager glob would pull every page into startup.
 */
export function registerLoadedHostModule(
  key: string,
  module: Record<string, unknown>,
): Record<string, unknown> {
  const existing = moduleRegistry.getModule(key);
  if (existing) {
    for (const name of Object.keys(module)) {
      if (!Object.prototype.hasOwnProperty.call(existing, name)) {
        existing[name] = module[name];
      }
    }
    return existing;
  }
  moduleRegistry.register(key, module);
  return moduleRegistry.getModule(key)!;
}
