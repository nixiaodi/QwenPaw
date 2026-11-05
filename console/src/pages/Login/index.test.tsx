import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { create } from "zustand";

vi.mock("../../stores/authStore", () => ({
  useAuthStore: create(() => ({
    phase: "authenticated",
    hasUsers: true,
    bootstrapError: false,
    login: vi.fn(),
    register: vi.fn(),
    bootstrap: vi.fn(),
  })),
}));
vi.mock("../../api/modules/auth", () => ({
  authApi: {
    getStatus: vi.fn(async () => ({
      enabled: true,
      has_users: true,
      mode: "multi_user",
    })),
  },
}));
vi.mock("../../contexts/ThemeContext", () => ({
  useTheme: () => ({ isDark: false }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
import LoginPage from "./index";
import { useAuthStore } from "../../stores/authStore";

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    phase: "authenticated",
    bootstrapError: false,
    hasUsers: true,
  });
});
function showLogin(path = "/login") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/chat" element={<div>首页</div>} />
        <Route path="/sessions" element={<div>会话页面</div>} />
      </Routes>
    </MemoryRouter>,
  );
}
it("returns an authenticated visitor to the home chat without replacing their identity", async () => {
  const view = showLogin();
  await waitFor(() => expect(view.getByText("首页")).toBeTruthy());
  expect(useAuthStore.getState().phase).toBe("authenticated");
});

it("restores a cookie session before deciding whether to show the login form", async () => {
  useAuthStore.setState({ phase: "loading" });
  vi.mocked(useAuthStore.getState().bootstrap).mockImplementation(async () => {
    useAuthStore.setState({ phase: "authenticated" });
  });
  const view = showLogin();
  await waitFor(() => expect(view.getByText("首页")).toBeTruthy());
  expect(view.queryByPlaceholderText("login.passwordPlaceholder")).toBeNull();
});

it("allows a local return path", async () => {
  const view = showLogin("/login?redirect=%2Fsessions");
  await waitFor(() => expect(view.getByText("会话页面")).toBeTruthy());
});

it.each([
  "/login",
  "/console/login",
  "//example.com",
  "/\\example.com",
  "/foo/../login",
  "/login/",
  "/%6cogin",
  "/%invalid",
])("does not loop or navigate off-site for %s", async (redirect) => {
  const view = showLogin("/login?redirect=" + encodeURIComponent(redirect));
  await waitFor(() => expect(view.getByText("首页")).toBeTruthy());
});

it("keeps an explicitly anonymous visitor on the login form", () => {
  useAuthStore.setState({ phase: "anonymous" });
  const view = showLogin();
  expect(view.getByPlaceholderText("login.passwordPlaceholder")).toBeTruthy();
  expect(useAuthStore.getState().bootstrap).not.toHaveBeenCalled();
});

it("retries a temporary connection failure without presenting a password form", async () => {
  useAuthStore.setState({ phase: "loading", bootstrapError: true });
  vi.mocked(useAuthStore.getState().bootstrap).mockResolvedValue(undefined);
  const view = showLogin();
  expect(view.queryByPlaceholderText("login.passwordPlaceholder")).toBeNull();
  vi.mocked(useAuthStore.getState().bootstrap).mockImplementation(async () => {
    useAuthStore.setState({ phase: "authenticated", bootstrapError: false });
  });
  fireEvent.click(view.getByText("login.retrySession"));
  await waitFor(() => expect(view.getByText("首页")).toBeTruthy());
});
