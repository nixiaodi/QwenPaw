import { Suspense } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moduleRegistry } from "../plugins/moduleRegistry";
import { lazyImportWithRetry, lazyWithRetry } from "./lazyWithRetry";

vi.mock("../pages/Settings/Debug/index.tsx", () => ({
  default: () => <div>Debug page</div>,
  debugHelper: () => "debug helper",
}));

afterEach(cleanup);

describe("page registration on demand", () => {
  it("does not load a page until rendered, then registers all exports under its resolved path", async () => {
    const Page = lazyImportWithRetry("../../pages/Settings/Debug/index.tsx");
    expect(moduleRegistry.getModule("Settings/Debug/index")).toBeUndefined();

    render(
      <Suspense fallback="Loading">
        <Page />
      </Suspense>,
    );
    expect(await screen.findByText("Debug page")).toBeInTheDocument();
    expect(
      moduleRegistry.getModule("Settings/Debug/index")?.debugHelper,
    ).toBeTypeOf("function");
    expect(
      moduleRegistry.getModule("Settings/Debug/index")?.default,
    ).toBeTypeOf("function");
  });

  it("registers explicit file paths without appending an extra index segment", async () => {
    const Page = lazyWithRetry(
      async () => ({
        default: () => <div>Single module</div>,
        helper: "available",
      }),
      "../pages/StartupFixture/Single.tsx",
    );
    render(
      <Suspense fallback="Loading">
        <Page />
      </Suspense>,
    );
    await screen.findByText("Single module");
    expect(moduleRegistry.getModule("StartupFixture/Single")?.helper).toBe(
      "available",
    );
  });

  it("preserves plugin overrides and module references when a page is loaded", async () => {
    const PatchedPage = () => <div>Plugin page</div>;
    moduleRegistry.register("StartupFixture/Patched/index", {
      default: PatchedPage,
    });
    const existing = moduleRegistry.getModule("StartupFixture/Patched/index");
    const Page = lazyWithRetry(
      async () => ({
        default: () => <div>Host page</div>,
        helper: "host helper",
      }),
      "../pages/StartupFixture/Patched",
    );

    render(
      <Suspense fallback="Loading">
        <Page />
      </Suspense>,
    );
    expect(await screen.findByText("Plugin page")).toBeInTheDocument();
    expect(moduleRegistry.getModule("StartupFixture/Patched/index")).toBe(
      existing,
    );
    expect(existing?.helper).toBe("host helper");
  });
});
