import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupWizard } from "./SetupWizard";
import type { MultiServerPlan, Task } from "../api/setup";

const stateMock = vi.fn();
const tasksMock = vi.fn();
const multiServerPlanMock = vi.fn();
const multiServerApplyMock = vi.fn();
const taskMock = vi.fn();

vi.mock("../api/setup", () => ({
  setupApi: {
    state: (...args: unknown[]) => stateMock(...args),
    tasks: (...args: unknown[]) => tasksMock(...args),
    task: (...args: unknown[]) => taskMock(...args),
    preflight: vi.fn().mockResolvedValue({ checks: [], summary: {} }),
    writeConfig: vi.fn().mockResolvedValue({ ok: true }),
    writeOAuthConfig: vi.fn().mockResolvedValue({ ok: true, changes: [] }),
    saveOAuthSecret: vi.fn().mockResolvedValue({ ok: true }),
    saveToken: vi.fn().mockResolvedValue({ ok: true }),
    init: vi.fn(),
    multiServerPlan: (...args: unknown[]) => multiServerPlanMock(...args),
    multiServerApply: (...args: unknown[]) => multiServerApplyMock(...args)
  }
}));

function fakePlan(instance: number): MultiServerPlan {
  const stride = (instance - 1) * 1000;
  return {
    stride: 1000,
    profiles: [{
      instance,
      client: 7777 + stride,
      client_end: 7810 + stride,
      igw: 7888 + stride,
      igw_end: 7921 + stride,
      postgres: 15432 + stride,
      rmq_admin: 32573 + stride,
      rmq_game: 31982 + stride,
      rmq_game_http: 31983 + stride,
      rmq_game_local_http: 15672 + stride,
      text_router: 5059 + stride,
      director: 11717 + stride,
      admin_web: 8088 + stride,
      prometheus: 9090 + stride
    }]
  };
}

function fakeTask(status: Task["status"]): Task {
  return {
    id: "multi-server-1",
    type: "setup",
    operation: "multiServerApplyAndRestart",
    status,
    currentStep: "Applying instance profile",
    progressMessage: "",
    logLines: [],
    warnings: [],
    startedAt: "2026-08-15T00:00:00.000Z",
    finishedAt: status === "succeeded" ? "2026-08-15T00:01:00.000Z" : null,
    errorMessage: null
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("SetupWizard multi-server instance selection (issue #277)", () => {
  it("defaults to single-server: never calls multiServerPlan until the operator explicitly opts in", async () => {
    stateMock.mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_IP_MODE: "public" } });
    tasksMock.mockResolvedValue({ tasks: [] });

    render(<SetupWizard mode="first-run" initialStep={7} />);

    await waitFor(() => expect(screen.getByText("Ports and Firewall")).toBeInTheDocument());
    expect(screen.getByLabelText(/Single server/i)).toBeChecked();
    expect(multiServerPlanMock).not.toHaveBeenCalled();
  });

  it("fetches and displays the real plan the moment multi-server is selected, and requires explicit confirmation before the apply button is enabled", async () => {
    stateMock.mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_IP_MODE: "public", SERVER_IP: "203.0.113.10" } });
    tasksMock.mockResolvedValue({ tasks: [] });
    multiServerPlanMock.mockResolvedValue({ plan: fakePlan(2) });

    render(<SetupWizard mode="first-run" initialStep={7} />);

    await waitFor(() => expect(screen.getByText("Ports and Firewall")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/Part of a multi-server group/i));

    await waitFor(() => expect(multiServerPlanMock).toHaveBeenCalledWith(2));
    await waitFor(() => expect(screen.getByText(/8777-8810/)).toBeInTheDocument());
    expect(screen.getByText(/8888-8921/)).toBeInTheDocument();
    expect(screen.getByText(/16432/)).toBeInTheDocument();

    // Explicit "no auto-detection" warning must always be visible once a
    // plan is shown -- this is the whole point of #277's design: never
    // imply a collision check happened when it didn't.
    expect(screen.getByText(/cannot detect other Dune installations/i)).toBeInTheDocument();

    const applyButton = screen.getByRole("button", { name: /Apply instance 2's ports/i });
    expect(applyButton).toBeDisabled();

    const confirmCheckbox = screen.getByLabelText(/I have confirmed instance 2 is not already used elsewhere/i);
    fireEvent.click(confirmCheckbox);
    expect(applyButton).toBeEnabled();
  });

  it("re-fetches a fresh plan when the instance number changes, and clears the plan when switching back to single-server", async () => {
    stateMock.mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_IP_MODE: "public", SERVER_IP: "203.0.113.10" } });
    tasksMock.mockResolvedValue({ tasks: [] });
    multiServerPlanMock.mockImplementation((instances: number) => Promise.resolve({ plan: fakePlan(instances) }));

    render(<SetupWizard mode="first-run" initialStep={7} />);

    await waitFor(() => expect(screen.getByText("Ports and Firewall")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/Part of a multi-server group/i));
    await waitFor(() => expect(multiServerPlanMock).toHaveBeenCalledWith(2));

    const instanceInput = screen.getByRole("spinbutton");
    fireEvent.change(instanceInput, { target: { value: "3" } });
    await waitFor(() => expect(multiServerPlanMock).toHaveBeenLastCalledWith(3));
    await waitFor(() => expect(screen.getByText(/9777-9810/)).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/Single server/i));
    await waitFor(() => expect(screen.queryByText(/9777-9810/)).not.toBeInTheDocument());
  });

  it("does not allow applying when the server is not in public mode, even if a plan somehow loaded", async () => {
    stateMock.mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_IP_MODE: "local", SERVER_IP: "192.168.1.50" } });
    tasksMock.mockResolvedValue({ tasks: [] });
    multiServerPlanMock.mockResolvedValue({ plan: fakePlan(2) });

    render(<SetupWizard mode="first-run" initialStep={7} />);

    await waitFor(() => expect(screen.getByText("Ports and Firewall")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/Part of a multi-server group/i));

    await waitFor(() => expect(screen.getByText(/require public hosting mode/i)).toBeInTheDocument());
    const confirmCheckbox = screen.getByLabelText(/I have confirmed instance 2 is not already used elsewhere/i);
    fireEvent.click(confirmCheckbox);
    expect(screen.getByRole("button", { name: /Apply instance 2's ports/i })).toBeDisabled();
  });

  it("calls multiServerApply with the confirmed instance number and public IP, then shows task progress", async () => {
    stateMock.mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_IP_MODE: "public", SERVER_IP: "203.0.113.10" } });
    tasksMock.mockResolvedValue({ tasks: [] });
    multiServerPlanMock.mockResolvedValue({ plan: fakePlan(2) });
    multiServerApplyMock.mockResolvedValue({ task: fakeTask("running") });
    taskMock.mockResolvedValue({ task: fakeTask("succeeded") });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ config: { ports: {}, port: 9088 } }), { status: 200, headers: { "content-type": "application/json" } })));

    render(<SetupWizard mode="first-run" initialStep={7} />);

    await waitFor(() => expect(screen.getByText("Ports and Firewall")).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/Part of a multi-server group/i));
    await waitFor(() => expect(screen.getByRole("button", { name: /Apply instance 2's ports/i })).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText(/I have confirmed instance 2 is not already used elsewhere/i));
    fireEvent.click(screen.getByRole("button", { name: /Apply instance 2's ports/i }));

    await waitFor(() => expect(multiServerApplyMock).toHaveBeenCalledWith(2, "203.0.113.10"));
  });
});
