import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, post } from "../../api/client";
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

const widget = (id: string) => document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`);

function renderPanel() {
  render(<SettingsPanel onPasswordChanged={vi.fn()} confirmAction={vi.fn().mockResolvedValue(true)} />);
}

// Returns the block that holds the new codes.
async function regenerateCodes() {
  vi.mocked(post).mockResolvedValue({ ok: true, recoveryCodes: ["AAAA-1111", "BBBB-2222"] } as never);
  fireEvent.click(await screen.findByLabelText("Expand Two-Factor Authentication"));
  fireEvent.change(screen.getByPlaceholderText("Your login password"), { target: { value: "password" } });
  fireEvent.change(screen.getByPlaceholderText("Current 6-digit code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByText("Regenerate Recovery Codes"));
  return (await screen.findByText("Save your new recovery codes")).closest<HTMLElement>(".wide")!;
}

// jsdom has no scrollIntoView; this one records its targets.
const scrolled: Element[] = [];
const originalScroll = Element.prototype.scrollIntoView;
beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
});
afterEach(() => { Element.prototype.scrollIntoView = originalScroll; });

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

  it("puts the two-factor warning at the two-factor card's place without scrolling to it", async () => {
    mockBackend({ secondFactorEnrolled: false, secondFactorUnavailable: true });
    renderPanel();

    const warning = await screen.findByText(/two-factor state could not be read/);
    // Seventh in the default Settings layout, between Login Password and Discord OAuth.
    expect(warning.style.order).toBe("60");
    expect(widget("settings.password")!.style.order).toBe("50");
    expect(widget("settings.discordOAuth")!.style.order).toBe("70");
    expect(scrolled).toEqual([]);
  });

  it("puts new recovery codes where the two-factor card was, outside every cell, and scrolls to them", async () => {
    const skin = { ...createDefaultSkinProfile(), id: "custom-test", name: "Custom Test" };
    const { widgets } = skin.pages.Settings;
    // Moved to the end, so the position can only come from the layout.
    widgets.push(...widgets.splice(widgets.findIndex((w) => w.id === "settings.twoFactor"), 1));
    saveAndApplySkin(skin);
    mockBackend({ secondFactorEnrolled: true });
    renderPanel();

    await waitFor(() => expect(widget("settings.twoFactor")).not.toBeNull());
    const cardOrder = widget("settings.twoFactor")!.style.order;
    expect(cardOrder).toBe(String((widgets.length - 1) * 10));
    const codes = await regenerateCodes();

    expect(codes.style.order).toBe(cardOrder);
    expect(codes.closest("[data-widget-id]")).toBeNull();
    expect(widget("settings.twoFactor")).toBeNull();
    expect(scrolled).toEqual([codes]);
  });
});

describe("SettingsPanel under the default appearance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    clearSkinDomOverrides();
    saveAndApplySkin(createDefaultSkinProfile());
  });

  it("leaves the recovery codes and the warning as plain elements and does not scroll", async () => {
    mockBackend({ secondFactorEnrolled: true });
    renderPanel();
    const codes = await regenerateCodes();

    expect(codes.getAttribute("class")).toBe("wide playerAdmin_toggle open");
    expect(codes.getAttribute("style")).toBeNull();

    mockBackend({ secondFactorEnrolled: false, secondFactorUnavailable: true });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const warning = await screen.findByText(/two-factor state could not be read/);
    expect(warning.tagName).toBe("P");
    expect(warning.getAttribute("class")).toBe("wide attention-text");
    expect(warning.getAttribute("style")).toBeNull();
    expect(scrolled).toEqual([]);
  });
});
