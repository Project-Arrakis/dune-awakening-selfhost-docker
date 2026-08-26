import type { ReactNode } from "react";

type RecoveryCodesPanelProps = {
  codes: string[];
  heading: string;
  intro: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  acknowledged: boolean;
  onAcknowledgedChange: (next: boolean) => void;
};

/**
 * The "here are your recovery codes, confirm you saved them" gate (RFC §4).
 *
 * Shared deliberately between first-time enrollment / recovery re-setup
 * (TotpSetupScreen) and the settings-panel regenerate action (#512), so the two
 * cannot drift into saying different things about codes that are shown exactly
 * once and are unrecoverable afterwards. The surrounding chrome differs (a
 * full-screen login panel vs. an inline settings section), so only the codes +
 * acknowledgment block lives here.
 */
export function RecoveryCodesPanel({
  codes,
  heading,
  intro,
  confirmLabel,
  onConfirm,
  acknowledged,
  onAcknowledgedChange,
}: RecoveryCodesPanelProps) {
  return (
    <>
      <h1 className="recovery-codes-heading">{heading}</h1>
      <p>{intro}</p>
      <ul className="totp-recovery-codes-list">
        {codes.map((recoveryCode) => <li key={recoveryCode}><code>{recoveryCode}</code></li>)}
      </ul>
      <label className="totp-ack-checkbox">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
        />
        I have saved these codes somewhere safe
      </label>
      <button type="button" disabled={!acknowledged} onClick={onConfirm}>{confirmLabel}</button>
    </>
  );
}
