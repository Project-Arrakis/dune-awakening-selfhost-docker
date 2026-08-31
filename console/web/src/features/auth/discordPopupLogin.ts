// Popup+poll Discord sign-in for the main console login (F4, #574).
//
// Every real effect (window.open, fetch, setTimeout) is injected so the
// state machine is testable without a fake-timer/DOM dance -- mirrors this
// codebase's own established pattern for testable async logic (fetchImpl in
// oauth.js/handoff.js, now() throughout). Deliberately NOT modeled on
// UpdatesPanel.tsx's loginQa(): that function is a plain uncancellable
// for/await-sleep loop with no unmount safety (confirmed during this
// feature's own L1 design audit) -- isMounted() is checked after every
// await here specifically so a caller can stop the state machine cold the
// moment its component unmounts, without needing to cancel an in-flight
// fetch.

export type DiscordAuthState = { authenticated: boolean; csrfToken: string | null };

export type DiscordPopupLoginDeps = {
  openPopup: () => Window | null;
  fetchAuthState: () => Promise<DiscordAuthState>;
  sleep: (ms: number) => Promise<void>;
  navigateFullPage: (url: string) => void;
  onSuccess: (state: DiscordAuthState) => void;
  isMounted: () => boolean;
  intervalMs?: number;
  maxAttempts?: number;
};

export type DiscordPopupLoginResult =
  | { outcome: "success" }
  | { outcome: "fallback" }
  | { outcome: "cancelled" }
  | { outcome: "timeout" }
  | { outcome: "unmounted" };

export async function runDiscordPopupLogin(deps: DiscordPopupLoginDeps): Promise<DiscordPopupLoginResult> {
  const { openPopup, fetchAuthState, sleep, navigateFullPage, onSuccess, isMounted, intervalMs = 2000, maxAttempts = 150 } = deps;

  const popup = openPopup();
  if (!popup) {
    // Popup blocked -- fall back on this SAME click, no second interaction
    // required (better than the QA reference, which just throws an error).
    navigateFullPage("/api/auth/discord/start");
    return { outcome: "fallback" };
  }
  popup.location.replace("/api/auth/discord/start?presentation=popup");

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(intervalMs);
    if (!isMounted()) return { outcome: "unmounted" };
    // Checked before polling: a popup closed by the operator (accidentally
    // or not) before completing is the only failure signal this flow has --
    // the specific reason, if any, was already shown inside the popup itself.
    if (popup.closed) return { outcome: "cancelled" };

    let state: DiscordAuthState | null = null;
    try {
      state = await fetchAuthState();
    } catch {
      continue; // a transient network hiccup -- keep polling, don't give up
    }
    if (!isMounted()) return { outcome: "unmounted" };
    if (state?.authenticated) {
      onSuccess(state);
      popup.close();
      return { outcome: "success" };
    }
  }

  popup.close();
  return { outcome: "timeout" };
}
