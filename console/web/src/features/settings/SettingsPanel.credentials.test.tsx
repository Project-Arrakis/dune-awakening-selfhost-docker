import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api, post } from "../../api/client";
import { SettingsPanel } from "./SettingsPanel";

vi.mock("../../api/client", () => ({
  api: vi.fn(),
  post: vi.fn(),
}));

const mockApi = vi.mocked(api);
const mockPost = vi.mocked(post);
const onPasswordChanged = vi.fn();

const STRONG_PASSWORD = "New-Correct-Horse-9!Battery";

// /api/settings is read first, then /api/auth/me for secondFactorEnrolled.
function mockBackend({ enrolled }: { enrolled: boolean }) {
  mockApi.mockImplementation((path: string) => {
    if (path === "/api/auth/me") return Promise.resolve({ secondFactorEnrolled: enrolled } as never);
    return Promise.resolve({ config: { port: 8088 }, publicDirectory: {}, serverConfig: {} } as never);
  });
}

async function openLoginPasswordSection() {
  fireEvent.click(await screen.findByLabelText("Expand Login Password"));
}

function fillPasswordFields() {
  fireEvent.change(screen.getByPlaceholderText("Current password"), { target: { value: "old-password" } });
  fireEvent.change(screen.getByPlaceholderText("At Least 13 Characters"), { target: { value: STRONG_PASSWORD } });
  fireEvent.change(screen.getByPlaceholderText("Confirm new password"), { target: { value: STRONG_PASSWORD } });
}

describe("SettingsPanel credential controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("password change with no second factor enrolled", () => {
    it("does not ask for an authenticator code and posts without one", async () => {
      mockBackend({ enrolled: false });
      mockPost.mockResolvedValue({ ok: true } as never);
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} />);
      await openLoginPasswordSection();

      expect(screen.queryByPlaceholderText("6-digit code")).toBeNull();

      fillPasswordFields();
      fireEvent.click(screen.getByText("Change Password"));

      await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
        "/api/settings/admin-password",
        { currentPassword: "old-password", newPassword: STRONG_PASSWORD }
      ));
    });
  });

  describe("password change with a second factor enrolled (#515)", () => {
    it("renders an authenticator-code field", async () => {
      mockBackend({ enrolled: true });
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} />);
      await openLoginPasswordSection();

      expect(await screen.findByPlaceholderText("6-digit code")).toBeTruthy();
    });

    // The regression itself: the server rejects a rotation with no totpCode
    // (server.js, "Enter your current authenticator code to change the
    // password"), so a form that cannot send one is a dead end.
    it("sends the authenticator code with the rotation request", async () => {
      mockBackend({ enrolled: true });
      mockPost.mockResolvedValue({ ok: true } as never);
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} />);
      await openLoginPasswordSection();
      await screen.findByPlaceholderText("6-digit code");

      fillPasswordFields();
      fireEvent.change(screen.getByPlaceholderText("6-digit code"), { target: { value: "123456" } });
      fireEvent.click(screen.getByText("Change Password"));

      await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
        "/api/settings/admin-password",
        { currentPassword: "old-password", newPassword: STRONG_PASSWORD, totpCode: "123456" }
      ));
    });

    it("keeps the submit button disabled until a code is entered", async () => {
      mockBackend({ enrolled: true });
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} />);
      await openLoginPasswordSection();
      await screen.findByPlaceholderText("6-digit code");

      fillPasswordFields();
      expect((screen.getByText("Change Password") as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(screen.getByPlaceholderText("6-digit code"), { target: { value: "123456" } });
      expect((screen.getByText("Change Password") as HTMLButtonElement).disabled).toBe(false);
    });

    it("clears the code after a rejected attempt so a stale one is not resubmitted", async () => {
      mockBackend({ enrolled: true });
      mockPost.mockRejectedValue(new Error("That authenticator code was not accepted."));
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} />);
      await openLoginPasswordSection();
      await screen.findByPlaceholderText("6-digit code");

      fillPasswordFields();
      fireEvent.change(screen.getByPlaceholderText("6-digit code"), { target: { value: "123456" } });
      fireEvent.click(screen.getByText("Change Password"));

      await waitFor(() => expect(
        (screen.getByPlaceholderText("6-digit code") as HTMLInputElement).value
      ).toBe(""));
    });
  });

  describe("recovery-code regeneration (#512 UI)", () => {
    it("is hidden entirely when no second factor is enrolled", async () => {
      mockBackend({ enrolled: false });
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} />);
      await screen.findByLabelText("Expand Login Password");

      expect(screen.queryByLabelText("Expand Two-Factor Authentication")).toBeNull();
    });

    it("posts password + code, then shows the new codes behind an acknowledgment gate", async () => {
      mockBackend({ enrolled: true });
      mockPost.mockResolvedValue({ ok: true, recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] } as never);
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} />);
      fireEvent.click(await screen.findByLabelText("Expand Two-Factor Authentication"));

      fireEvent.change(screen.getByPlaceholderText("Current password"), { target: { value: "old-password" } });
      fireEvent.change(screen.getByPlaceholderText("6-digit code"), { target: { value: "654321" } });
      fireEvent.click(screen.getByText("Regenerate Recovery Codes"));

      await waitFor(() => expect(mockPost).toHaveBeenCalledWith(
        "/api/auth/2fa/recovery-codes/regenerate",
        { currentPassword: "old-password", totpCode: "654321" }
      ));

      // Codes are displayed once, and "Done" stays disabled until acknowledged.
      expect(await screen.findByText("aaaa-bbbb")).toBeTruthy();
      const done = screen.getByText("Done") as HTMLButtonElement;
      expect(done.disabled).toBe(true);

      fireEvent.click(screen.getByRole("checkbox", { name: /saved these codes/i }));
      expect((screen.getByText("Done") as HTMLButtonElement).disabled).toBe(false);
    });

    it("surfaces a rejection and clears the code without showing any codes", async () => {
      mockBackend({ enrolled: true });
      mockPost.mockRejectedValue(new Error("Current password is incorrect."));
      render(<SettingsPanel onPasswordChanged={onPasswordChanged} />);
      fireEvent.click(await screen.findByLabelText("Expand Two-Factor Authentication"));

      fireEvent.change(screen.getByPlaceholderText("Current password"), { target: { value: "wrong" } });
      fireEvent.change(screen.getByPlaceholderText("6-digit code"), { target: { value: "654321" } });
      fireEvent.click(screen.getByText("Regenerate Recovery Codes"));

      await waitFor(() => expect(
        (screen.getByPlaceholderText("6-digit code") as HTMLInputElement).value
      ).toBe(""));
      expect(screen.queryByText("Save your new recovery codes")).toBeNull();
    });
  });
});
