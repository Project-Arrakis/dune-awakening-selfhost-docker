export async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Clipboard API is commonly blocked on plain HTTP LAN addresses.
      // Fall through to the synchronous selection-based browser fallback.
    }
  }

  const textarea = document.createElement("textarea");
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    if (typeof document.execCommand !== "function" || !document.execCommand("copy")) {
      throw new Error("Clipboard access is unavailable");
    }
  } finally {
    textarea.remove();
    previouslyFocused?.focus();
  }
}
