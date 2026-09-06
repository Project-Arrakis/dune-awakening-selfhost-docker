import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setupApi } from "../../api/setup";
import { ServerHostnameSetting, useServerHostname } from "./ServerHostnameSetting";

vi.mock("../../api/setup", () => ({ setupApi: { state: vi.fn(), writeConfig: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(setupApi.writeConfig).mockResolvedValue({ ok: true }); });
afterEach(cleanup);
it.each([
  [{ HOST_DATACENTER_ID: "game.example.com", SERVER_PROVIDER: "legacy.example.com" }, "game.example.com"],
  [{ HOST_DATACENTER_ID: "", SERVER_PROVIDER: "legacy.example.com" }, "legacy.example.com"],
  [{}, "dune-docker"]
])("shows the effective configured ID %j", async (serverConfig, expected) => {
  vi.mocked(setupApi.state).mockResolvedValue({ files: {}, config: {}, serverConfig });
  render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText("Server Hostname")).toHaveValue(expected));
  expect(screen.getByRole("button", { name: "Save Settings" })).toBeDisabled();
});
it("validates and saves only the hostname through the non-restarting config API", async () => {
  vi.mocked(setupApi.state).mockResolvedValue({ files: {}, config: {}, serverConfig: {} });
  render(<Harness />);
  const input = screen.getByLabelText("Server Hostname");
  await waitFor(() => expect(input).toHaveValue("dune-docker"));
  fireEvent.change(input, { target: { value: "https://invalid.example.com" } });
  expect(screen.getByRole("button", { name: "Save Settings" })).toBeDisabled();
  fireEvent.change(input, { target: { value: " game.example.com " } });
  fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));
  await screen.findByRole("status");
  expect(setupApi.writeConfig).toHaveBeenCalledExactlyOnceWith({ HOST_DATACENTER_ID: "game.example.com" });
  expect(screen.getByRole("status")).toHaveTextContent("Saved");
});
it("does not allow overwriting an unknown value after a load failure", async () => {
  vi.mocked(setupApi.state).mockRejectedValue(new Error("Offline"));
  render(<Harness />);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Save Settings" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
});
it("keeps unsaved edits available when saving fails", async () => {
  vi.mocked(setupApi.state).mockResolvedValue({ files: {}, config: {}, serverConfig: {} });
  vi.mocked(setupApi.writeConfig).mockRejectedValue(new Error("Offline"));
  render(<Harness />);
  const input = screen.getByLabelText("Server Hostname");
  await waitFor(() => expect(input).toHaveValue("dune-docker"));
  fireEvent.change(input, { target: { value: "game.example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));
  await screen.findByRole("alert");
  expect(input).toHaveValue("game.example.com");
  expect(screen.getByRole("button", { name: "Save Settings" })).toBeEnabled();
  expect(screen.queryByRole("status")).toBeNull();
});

function Harness() {
  const hostname = useServerHostname();
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  return <><ServerHostnameSetting hostname={hostname} disabled={false} /><button disabled={!hostname.ready || !hostname.valid || !hostname.changed} onClick={async () => {try {await hostname.save();setStatus("Saved");}catch {setError("Save failed");}}}>Save Settings</button>{status && <span role="status">{status}</span>}{error && <span role="alert">{error}</span>}</>;
}
it("keeps guidance behind the standard information icon without an extra save button", async () => {
  vi.mocked(setupApi.state).mockResolvedValue({ files: {}, config: {}, serverConfig: {} });
  render(<Harness />);
  await waitFor(() => expect(screen.getByLabelText("Server Hostname")).toHaveValue("dune-docker"));
  expect(screen.getByRole("button", {name:"About Server Hostname"})).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", {name:"About Server Hostname"}));
  expect(screen.getByRole("button", {name:"About Server Hostname"})).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByRole("button", {name:"Save Hostname"})).toBeNull();
});
