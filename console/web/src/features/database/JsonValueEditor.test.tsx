import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JsonValueEditor } from "./JsonValueEditor";

describe("JsonValueEditor", () => {
  it("formats and applies valid JSON", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<JsonValueEditor column="payload" value={'{"name":"Paul"}'} onApply={onApply} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Format JSON" }));
    expect(screen.getByRole("textbox", { name: "JSON value for payload" })).toHaveValue('{\n  "name": "Paul"\n}');
    fireEvent.click(screen.getByRole("button", { name: "Apply to Row" }));
    expect(onApply).toHaveBeenCalledWith('{\n  "name": "Paul"\n}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the editor open and reports invalid JSON", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<JsonValueEditor column="payload" value="{" onApply={onApply} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply to Row" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/JSON|position|property/i);
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("finds text and wraps to the first match", () => {
    render(<JsonValueEditor column="payload" value={'{"first":"spice","second":"spice"}'} onApply={() => undefined} onClose={() => undefined} />);
    const editor = screen.getByRole("textbox", { name: "JSON value for payload" }) as HTMLTextAreaElement;
    fireEvent.change(screen.getByRole("textbox", { name: "Find in JSON" }), { target: { value: "spice" } });
    fireEvent.click(screen.getByRole("button", { name: "Find Next" }));
    expect(editor.selectionStart).toBeGreaterThan(0);
    expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe("spice");
  });
});
