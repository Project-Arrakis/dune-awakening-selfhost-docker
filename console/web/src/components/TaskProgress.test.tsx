import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Task } from "../api/setup";
import { TaskProgress } from "./TaskProgress";

function failedDeployment(lines: string[]): Task {
  return {
    id: "deployment-1",
    type: "setup",
    operation: "init",
    status: "failed",
    currentStep: "Deploying",
    progressMessage: "",
    logLines: lines.map((line, index) => ({ timestamp: String(index), stream: "stdout", line })),
    warnings: [],
    startedAt: "2026-07-26T10:00:00.000Z",
    finishedAt: "2026-07-26T10:10:00.000Z",
    errorMessage: "Deployment command exited with status 1"
  };
}

describe("TaskProgress deployment failures", () => {
  it("does not misclassify Steam's generic low-disk troubleshooting bullet as a disk failure", () => {
    render(<TaskProgress task={failedDeployment([
      "[dune] Disk space at /srv/dune: 812.4 GiB free / 900.0 GiB total",
      "[dune] If SteamCMD printed \"state is 0x6\", common causes are:",
      "[dune]   - not enough free disk space in Docker's volume storage",
      "Steam could not download from its selected content host: cache12-ams1.steamcontent.com",
      "This is a Steam content-host failure, not an install-directory failure."
    ])} />);

    expect(screen.getByRole("heading", { name: /^Steam Download Failed\.?$/ })).toBeInTheDocument();
    expect(screen.getByText(/usually temporary; retry deployment later/i)).toBeInTheDocument();
    expect(screen.queryByText(/There is not enough free disk space/i)).not.toBeInTheDocument();
  });

  it("still reports an authoritative disk preflight failure with its measured free space", () => {
    render(<TaskProgress task={failedDeployment([
      "[dune] Not enough free disk space for a safe Dune server install/update.",
      "[dune] Free disk space is below the configured safety minimum:",
      "[dune]   /srv/dune: 12.5 GiB free, needs at least 25 GiB"
    ])} />);

    expect(screen.getByRole("heading", { name: /^Not Enough Disk Space\.?$/ })).toBeInTheDocument();
    expect(screen.getByText(/\/srv\/dune has 12.5 GiB free, but deployment requires at least 25 GiB/i)).toBeInTheDocument();
  });
});
