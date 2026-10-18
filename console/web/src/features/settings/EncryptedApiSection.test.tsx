import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EncryptedApiSection } from "./EncryptedApiSection";

vi.mock("../../api/client", () => ({ api: vi.fn(), post: vi.fn() }));
vi.mock("../../lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

import { api, post } from "../../api/client";
import { copyText } from "../../lib/clipboard";

const mockedApi = vi.mocked(api);
const mockedPost = vi.mocked(post);
const PIN = `sha256/${"B".repeat(43)}`;

function status(over: Record<string, unknown> = {}) {
  return { available: true, enabled: true, running: true, state: "running", health: "healthy", port: 8797, fingerprint: PIN, ...over };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedApi.mockResolvedValue(status());
  vi.mocked(copyText).mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

test("shows status, address and the key fingerprint, and copies it", async () => {
  render(<EncryptedApiSection />);
  expect(await screen.findByText("Running")).toBeVisible();
  expect(screen.getByText(PIN)).toBeVisible();
  expect(screen.getByText(`https://${window.location.hostname}:8797`)).toBeVisible();
  expect(screen.getByRole("checkbox", { name: /encrypted api access/i })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: /copy key fingerprint/i }));
  await waitFor(() => expect(copyText).toHaveBeenCalledWith(PIN));
  await waitFor(() => expect(screen.getByRole("button", { name: /copy key fingerprint/i })).toHaveTextContent("Copied"));
  fireEvent.click(screen.getByRole("button", { name: /copy api address/i }));
  await waitFor(() => expect(copyText).toHaveBeenLastCalledWith(`https://${window.location.hostname}:8797`));
});

test("an installation without the feature says so and offers no switch", async () => {
  mockedApi.mockResolvedValue(status({ available: false, enabled: false, running: false, fingerprint: "" }));
  render(<EncryptedApiSection />);
  expect(await screen.findByText("Not Available")).toBeVisible();
  expect(screen.getByText(/does not include the encrypted API access/i)).toBeVisible();
  expect(screen.queryByRole("checkbox")).toBeNull();
});

test("switching it on starts it and then shows the new fingerprint", async () => {
  mockedApi.mockResolvedValue(status({ enabled: false, running: false, state: "", health: "", fingerprint: "" }));
  mockedPost.mockResolvedValue(status());
  render(<EncryptedApiSection />);
  expect(await screen.findByRole("checkbox", { name: /encrypted api access/i })).not.toBeChecked();
  expect(within(screen.getByRole("status", { name: "Encrypted API Status" })).getByText("Disabled")).toBeVisible();
  expect(screen.queryByRole("button", { name: /copy key fingerprint/i })).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: /encrypted api access/i }));
  await waitFor(() => expect(mockedPost).toHaveBeenCalledWith("/api/settings/encrypted-api", { enabled: true }));
  expect(await screen.findByText(PIN)).toBeVisible();
  expect(screen.queryByText(/Encrypted API access enabled/i)).toBeNull();
  expect(screen.queryByText("Status")).toBeNull();
  expect(screen.queryByText("On")).toBeNull();
  expect(screen.getByRole("status", { name: "Encrypted API Status" })).toHaveTextContent("Running");
});

test("a failed start is reported and the section stays usable", async () => {
  mockedApi.mockResolvedValue(status({ enabled: false, running: false, fingerprint: "" }));
  mockedPost.mockRejectedValue(new Error("The encrypted API access could not be started."));
  render(<EncryptedApiSection />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /encrypted api access/i }));
  expect(await screen.findByText(/could not be started/i)).toBeVisible();
  expect(screen.getByRole("checkbox", { name: /encrypted api access/i })).not.toBeDisabled();
});

test("refreshes Starting to Running without leaving the page", async () => {
  vi.useFakeTimers();
  mockedApi.mockResolvedValueOnce(status({ enabled: false, running: false, health: "", fingerprint: "" }));
  mockedPost.mockResolvedValue(status({ health: "starting" }));
  render(<EncryptedApiSection />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("checkbox", { name: /encrypted api access/i }));
  await act(async () => {});
  expect(screen.getByText("Starting")).toBeVisible();
  expect(screen.queryByText("Running")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText("Running")).toBeVisible();
});

test("continues refreshing healthy status and notices external stops", async () => {
  vi.useFakeTimers();
  render(<EncryptedApiSection />);
  await act(async () => {});
  expect(screen.getByText("Running")).toBeVisible();
  mockedApi.mockResolvedValue(status({ running: false, state: "exited", health: "" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText("Stopped")).toBeVisible();
});

test("a stale status response cannot undo a completed toggle", async () => {
  vi.useFakeTimers();
  const off = status({ enabled: false, running: false, health: "", fingerprint: "" });
  mockedApi.mockResolvedValueOnce(off);
  let resolveOld!: (value: ReturnType<typeof status>) => void;
  mockedApi.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  mockedPost.mockResolvedValue(status());
  render(<EncryptedApiSection />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  fireEvent.click(screen.getByRole("checkbox", { name: /encrypted api access/i }));
  await act(async () => {});
  await act(async () => { resolveOld(off); });
  expect(screen.getByRole("checkbox", { name: /encrypted api access/i })).toBeChecked();
  expect(screen.getByText("Running")).toBeVisible();
});

test("does not overlap status requests or keep polling after unmount", async () => {
  vi.useFakeTimers();
  let resolveStatus!: (value: ReturnType<typeof status>) => void;
  mockedApi.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
  const { unmount } = render(<EncryptedApiSection />);
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(mockedApi).toHaveBeenCalledTimes(1);
  unmount();
  await act(async () => { resolveStatus(status()); });
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
  expect(mockedApi).toHaveBeenCalledTimes(1);
});

test("a temporary status error retries without claiming the feature is absent", async () => {
  vi.useFakeTimers();
  mockedApi.mockRejectedValueOnce(new Error("Connection interrupted."));
  render(<EncryptedApiSection />);
  await act(async () => {});
  expect(screen.getByRole("alert")).toHaveTextContent("Retrying automatically");
  expect(screen.queryByText("Not Available")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText("Running")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});
