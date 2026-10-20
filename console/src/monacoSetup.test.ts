import { describe, expect, it, vi } from "vitest";

const loaderConfig = vi.hoisted(() => vi.fn());
vi.mock("@monaco-editor/react", () => ({ loader: { config: loaderConfig } }));
vi.mock("monaco-editor", () => ({
  languages: {
    getLanguages: () => [],
    register: () => {},
    setLanguageConfiguration: () => {},
    setMonarchTokensProvider: () => {},
  },
}));
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: class {
    kind = "editor";
  },
}));
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({
  default: class {
    kind = "json";
  },
}));
vi.mock("monaco-editor/esm/vs/language/css/css.worker?worker", () => ({
  default: class {
    kind = "css";
  },
}));
vi.mock("monaco-editor/esm/vs/language/html/html.worker?worker", () => ({
  default: class {
    kind = "html";
  },
}));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({
  default: class {
    kind = "typescript";
  },
}));

describe("offline editor initialization", () => {
  it("uses the bundled Monaco instance and resolves every worker locally", async () => {
    await import("./monacoSetup");
    const bundledMonaco = await import("monaco-editor");
    expect(loaderConfig).toHaveBeenCalledWith({ monaco: bundledMonaco });
    const getWorker = self.MonacoEnvironment!.getWorker!;
    for (const [label, expected] of [
      ["json", "json"],
      ["css", "css"],
      ["scss", "css"],
      ["less", "css"],
      ["html", "html"],
      ["handlebars", "html"],
      ["razor", "html"],
      ["typescript", "typescript"],
      ["javascript", "typescript"],
      ["plaintext", "editor"],
    ]) {
      expect(await getWorker("", label)).toHaveProperty("kind", expected);
    }
  });
});
