import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { api } from "../../api/client";
import { createDefaultSkinProfile } from "../../skins/skinDefaults";
import { clearSkinDomOverrides, saveAndApplySkin } from "../../skins/skinEngine";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("../../api/client", () => ({
  api: vi.fn(),
  post: vi.fn(),
}));

const mockApi = vi.mocked(api);

function mockBackend(secondFactor: { secondFactorEnrolled: boolean; secondFactorUnavailable?: boolean }) {
  mockApi.mockImplementation((path: string) => Promise.resolve(
    (path === "/api/auth/me" ? secondFactor : { config: { port: 8088 }, publicDirectory: {}, serverConfig: {} }) as never
  ));
}

const widget = (id: string) => document.querySelector(`[data-widget-id="${id}"]`);

function renderPanel() {
  render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn().mockResolvedValue(true)} />);
}

describe("SettingsPanel under a custom skin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    saveAndApplySkin({ ...createDefaultSkinProfile(), id: "custom-test", name: "Custom Test" });
  });

  afterEach(() => {
    window.localStorage.clear();
    clearSkinDomOverrides();
  });

  it("gives two-factor no layout cell when there is nothing to put in it", async () => {
    mockBackend({ secondFactorEnrolled: false });
    renderPanel();

    await screen.findByLabelText("Expand Login Password");
    expect(widget("settings.password")).not.toBeNull();
    expect(widget("settings.twoFactor")).toBeNull();
  });

  it("gives two-factor its own layout cell once enrolled", async () => {
    mockBackend({ secondFactorEnrolled: true });
    renderPanel();

    await waitFor(() => expect(widget("settings.twoFactor")).not.toBeNull());
  });

  it("shows the two-factor warning outside every layout cell", async () => {
    mockBackend({ secondFactorEnrolled: false, secondFactorUnavailable: true });
    renderPanel();

    const warning = await screen.findByText(/two-factor state could not be read/);
    expect(warning.closest("[data-widget-id]")).toBeNull();
  });
});
