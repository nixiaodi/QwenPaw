import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Follow runtime imports only: lazy page imports must stay outside the initial graph.
function eagerModules(entry: string, visited = new Set<string>()): Set<string> {
  const resolved = [
    entry,
    `${entry}.ts`,
    `${entry}.tsx`,
    `${entry}/index.ts`,
    `${entry}/index.tsx`,
  ].find(
    (candidate) => existsSync(candidate) && /\.[cm]?[jt]sx?$/.test(candidate),
  );
  if (!resolved || visited.has(resolved)) return visited;
  visited.add(resolved);
  // Match Vite's type erasure, including older imports used only in annotations.
  const runtimeSource = ts.transpileModule(readFileSync(resolved, "utf8"), {
    fileName: resolved,
    compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
  }).outputText;
  const source = ts.createSourceFile(
    resolved,
    runtimeSource,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (
      (!ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement)) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
    const clause = ts.isImportDeclaration(statement)
      ? statement.importClause
      : undefined;
    if (clause?.isTypeOnly) continue;
    if (
      clause &&
      !clause.name &&
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.every((element) => element.isTypeOnly)
    )
      continue;
    const specifier = statement.moduleSpecifier.text;
    if (specifier.startsWith("."))
      eagerModules(path.resolve(path.dirname(resolved), specifier), visited);
    else if (specifier.startsWith("@/"))
      eagerModules(path.resolve("src", specifier.slice(2)), visited);
    else visited.add(specifier);
  }
  return visited;
}

describe("initial application dependencies", () => {
  it("keeps the offline Monaco runtime outside the entrypoint's eager graph", () => {
    const modules = eagerModules(path.resolve("src/main.tsx"));
    expect(modules.has(path.resolve("src/monacoSetup.ts"))).toBe(false);
    expect(modules.has(path.resolve("src/pages/Coding/TabbedEditor.tsx"))).toBe(
      false,
    );
  });

  it("loads the chat workspace only after its route is visited", () => {
    const modules = eagerModules(path.resolve("src/main.tsx"));
    expect(modules.has(path.resolve("src/pages/Chat/route.tsx"))).toBe(false);
    expect(modules.has(path.resolve("src/pages/Chat/index.tsx"))).toBe(false);
  });

  it("does not pull the chat barrel or syntax renderers through synchronous plugin registration", () => {
    const modules = eagerModules(path.resolve("src/main.tsx"));
    expect(modules.has("@agentscope-ai/chat")).toBe(false);
    expect(
      [...modules].filter((module) =>
        module.startsWith("react-syntax-highlighter"),
      ),
    ).toEqual([]);
  });
});
