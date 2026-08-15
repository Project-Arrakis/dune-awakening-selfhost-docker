import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { databaseApi } from "../../api/database";
import { DatabaseSchemaBrowser } from "./DatabaseSchemaBrowser";

vi.mock("../../api/database", () => ({
  databaseApi: {
    columns: vi.fn(),
    routines: vi.fn(),
    routineDefinition: vi.fn()
  }
}));

describe("DatabaseSchemaBrowser", () => {
  beforeEach(() => {
    vi.mocked(databaseApi.routines).mockResolvedValue([{
      oid: "123",
      schema: "dune",
      name: "refresh_player",
      kind: "function",
      arguments: "account_id bigint",
      result_type: "void",
      language: "plpgsql",
      owner: "dune"
    }]);
    vi.mocked(databaseApi.routineDefinition).mockResolvedValue({
      oid: "123",
      schema: "dune",
      name: "refresh_player",
      kind: "function",
      arguments: "account_id bigint",
      definition: "CREATE OR REPLACE FUNCTION dune.refresh_player(account_id bigint) RETURNS void ..."
    });
  });

  it("browses routine signatures, definitions, and creates a SQL call", async () => {
    const onCreateQuery = vi.fn();
    render(<DatabaseSchemaBrowser schema="dune" tables={[]} onCreateQuery={onCreateQuery} />);
    fireEvent.click(screen.getByRole("tab", { name: "Functions & Procedures" }));
    expect(await screen.findByText("dune.refresh_player")).toBeInTheDocument();
    expect(screen.getByText("account_id bigint")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show definition for refresh_player" }));
    expect(await screen.findByText(/CREATE OR REPLACE FUNCTION/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create query for refresh_player" }));
    expect(onCreateQuery).toHaveBeenCalledWith('SELECT "dune"."refresh_player"(/* account_id bigint */);');
    await waitFor(() => expect(databaseApi.routineDefinition).toHaveBeenCalledWith("123"));
  });
});
