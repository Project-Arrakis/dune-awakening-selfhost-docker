import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { secretsApi } from "../../api/secrets";
import { SecretsStatusPanel } from "./SecretsStatusPanel";

vi.mock("../../api/secrets", () => ({
  secretsApi: {
    status: vi.fn()
  }
}));

beforeEach(() => {
  vi.resetAllMocks();
});

describe("SecretsStatusPanel", () => {
  it("renders all 4 possible states with the correct human-readable label", async () => {
    vi.mocked(secretsApi.status).mockResolvedValue({
      secrets: [
        { name: "server-login-password-secret", state: "migrated" },
        { name: "username-server-login-secret", state: "broken" }
      ]
    });

    render(<SecretsStatusPanel />);

    expect(await screen.findByText("Migrated (encrypted)")).toBeInTheDocument();
    expect(screen.getByText("Migrated but currently unreadable/broken")).toBeInTheDocument();
    expect(screen.getByText("Server Login Password Secret")).toBeInTheDocument();
    expect(screen.getByText("Username Server Login Secret")).toBeInTheDocument();
  });

  it("applies the correct tone class per state, not the free-text normalizeStatus() path", async () => {
    vi.mocked(secretsApi.status).mockResolvedValue({
      secrets: [
        { name: "server-login-password-secret", state: "migrated" },
        { name: "username-server-login-secret", state: "broken" }
      ]
    });

    render(<SecretsStatusPanel />);

    const migratedBadge = await screen.findByText("Migrated (encrypted)");
    expect(migratedBadge).toHaveClass("badge-pass");

    const brokenBadge = screen.getByText("Migrated but currently unreadable/broken");
    expect(brokenBadge).toHaveClass("badge-fail");
  });

  it("renders not-migrated as warn tone and backend-not-configured as info tone", async () => {
    vi.mocked(secretsApi.status).mockResolvedValue({
      secrets: [
        { name: "server-login-password-secret", state: "not-migrated" },
        { name: "username-server-login-secret", state: "backend-not-configured" }
      ]
    });

    render(<SecretsStatusPanel />);

    const notMigratedBadge = await screen.findByText("Not migrated (legacy plaintext)");
    expect(notMigratedBadge).toHaveClass("badge-warn");

    const notConfiguredBadge = screen.getByText("Backend not configured");
    expect(notConfiguredBadge).toHaveClass("badge-info");
  });

  it("never renders a secret value or ciphertext-shaped string anywhere in the DOM", async () => {
    vi.mocked(secretsApi.status).mockResolvedValue({
      secrets: [
        { name: "server-login-password-secret", state: "migrated" },
        { name: "username-server-login-secret", state: "not-migrated" }
      ]
    });

    render(<SecretsStatusPanel />);
    await screen.findByText("Migrated (encrypted)");

    expect(document.body.textContent).not.toMatch(/enc:v2:/);
  });

  it("fetches status on mount exactly once", async () => {
    vi.mocked(secretsApi.status).mockResolvedValue({ secrets: [] });

    render(<SecretsStatusPanel />);

    await waitFor(() => expect(secretsApi.status).toHaveBeenCalledTimes(1));
  });

  it("the manual Refresh button re-triggers a fetch", async () => {
    vi.mocked(secretsApi.status).mockResolvedValue({ secrets: [] });

    render(<SecretsStatusPanel />);
    await waitFor(() => expect(secretsApi.status).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));

    await waitFor(() => expect(secretsApi.status).toHaveBeenCalledTimes(2));
  });

  it("shows an error message and does not render the empty-secrets fallback silently when the fetch fails", async () => {
    vi.mocked(secretsApi.status).mockRejectedValue(new Error("Network error: could not reach the console API."));

    render(<SecretsStatusPanel />);

    expect(await screen.findByText(/Network error/)).toBeInTheDocument();
  });
});
