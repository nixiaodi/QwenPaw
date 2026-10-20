import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./i18n";
import i18n from "./i18n";
import App from "./App";

const state = vi.hoisted(() => ({
  pluginsLoading: true,
  auth: {
    phase: "loading",
    mode: "legacy",
    preferences: null,
    bootstrap: () => Promise.resolve(),
  },
}));
vi.mock("@agentscope-ai/design", () => ({
  ConfigProvider: ({ children }: { children: ReactNode }) => children,
  bailianTheme: {},
  bailianDarkTheme: {},
}));
vi.mock("./plugins/PluginContext", () => ({
  PluginProvider: ({ children }: { children: ReactNode }) => children,
  usePlugins: () => ({ loading: state.pluginsLoading }),
}));
vi.mock("./stores/authStore", () => ({
  useAuthStore: (selector: (value: typeof state.auth) => unknown) =>
    selector(state.auth),
}));
vi.mock("./stores/uploadLimitStore", () => ({
  useUploadLimitStore: { getState: () => ({ fetch: () => Promise.resolve() }) },
}));
vi.mock("./layouts/MainLayout", () => ({ default: () => null }));
vi.mock("./contexts/ApprovalContext", () => ({
  ApprovalProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./contexts/DesktopUpdateContext", () => ({
  DesktopUpdateProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/UpdateTakeoverPage", () => ({
  UpdateTakeoverGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./tauri/CloseWindowPrompt", () => ({ default: () => null }));

afterEach(cleanup);

describe("application loading states", () => {
  it("shows a translated status while plugins are loading", async () => {
    state.pluginsLoading = true;
    await i18n.changeLanguage("zh");
    render(<App />);
    expect(screen.getByRole("status")).toHaveTextContent("加载");
  });

  it("keeps a visible status while authentication is pending", async () => {
    state.pluginsLoading = false;
    await i18n.changeLanguage("en");
    render(<App />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });
});
