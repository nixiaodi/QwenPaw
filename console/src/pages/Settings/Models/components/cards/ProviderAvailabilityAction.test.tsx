import { expect, it, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { ProviderAvailabilityAction } from "./ProviderAvailabilityAction";
import { providerApi } from "@/api/modules/provider";

vi.mock("@/api/modules/provider", () => ({
  providerApi: { configureProvider: vi.fn() },
}));
vi.mock("@/hooks/useAppMessage", () => ({
  useAppMessage: () => ({ message: { error: vi.fn() } }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each(["opencode", "kilo", "custom"])(
  "disables %s without deleting credentials",
  async (id) => {
    vi.mocked(providerApi.configureProvider).mockResolvedValue({ id } as never);
    const saved = vi.fn();
    render(
      <ProviderAvailabilityAction
        provider={{ id, require_api_key: false } as never}
        onSaved={saved}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "common.disable" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(providerApi.configureProvider).toHaveBeenCalledWith(id, {
      enabled: false,
    });
  },
);

it("can re-enable a disabled provider", async () => {
  vi.mocked(providerApi.configureProvider).mockResolvedValue({
    id: "kilo",
  } as never);
  render(
    <ProviderAvailabilityAction
      provider={{ id: "kilo", enabled: false } as never}
      onSaved={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "common.enable" }));
  await waitFor(() =>
    expect(providerApi.configureProvider).toHaveBeenCalledWith("kilo", {
      enabled: true,
    }),
  );
});
