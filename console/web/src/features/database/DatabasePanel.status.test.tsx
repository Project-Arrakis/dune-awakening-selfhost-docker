import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { databaseApi } from "../../api/database";
import { DatabasePanel } from "./DatabasePanel";

vi.mock("../../api/database", () => ({
  databaseApi: {
    tables: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({
      connected: true,
      usesDefaultPassword: false,
      config: { host: "127.0.0.1", port: 15432, database: "dune", user: "dune" },
      server: { current_database: "dune", current_user: "dune", version: "PostgreSQL test" },
      sshTunnelAccess: { available: true, loopbackOnly: true, host: "127.0.0.1", port: 15432, database: "dune", user: "dune" }
    })
  }
}));

vi.mock("../../api/setup", () => ({ setupApi: { task: vi.fn() } }));

describe("DatabasePanel status visibility", () => {
  it("loads tunnel details without opening the transient Status result", async () => {
    render(<DatabasePanel />);
    fireEvent.click(screen.getByRole("button", { name: "SSH Tunnel Access" }));
    await waitFor(() => expect(databaseApi.status).toHaveBeenCalledOnce());
    expect(await screen.findByText("Connect DBeaver or another PostgreSQL application", { exact: false })).toBeInTheDocument();
    expect(screen.getByDisplayValue(/ssh -N -o ExitOnForwardFailure=yes/)).toBeInTheDocument();
    expect(screen.getByText("Run the command on the computer running DBeaver")).toBeInTheDocument();
    expect(screen.getByText("Your Dune database password")).toBeInTheDocument();
    expect(screen.queryByText("Database Status")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    const statusTitle = await screen.findByText("Database Status");
    expect(statusTitle).toBeInTheDocument();
    expect(statusTitle.closest("section")).not.toHaveClass("transient-result");
    expect(databaseApi.status).toHaveBeenCalledTimes(2);
  });
});
