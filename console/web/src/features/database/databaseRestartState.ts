const DATABASE_RESTART_TASK_KEY = "arrakis.databaseRestartTaskId";
const LEGACY_DATABASE_PASSWORD_STATE_KEY = "arrakis.databasePasswordState";
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function loadDatabaseRestartTaskId(): string | undefined {
  if (typeof window === "undefined") return undefined;

  // Earlier releases persisted the whole password-change result. It never
  // contained the password, but remove it during migration so only the opaque
  // server-side task identifier remains in browser storage.
  window.localStorage.removeItem(LEGACY_DATABASE_PASSWORD_STATE_KEY);

  const taskId = window.sessionStorage.getItem(DATABASE_RESTART_TASK_KEY) || "";
  if (!TASK_ID_PATTERN.test(taskId)) {
    window.sessionStorage.removeItem(DATABASE_RESTART_TASK_KEY);
    return undefined;
  }
  return taskId;
}

export function persistDatabaseRestartTaskId(taskId?: string) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(LEGACY_DATABASE_PASSWORD_STATE_KEY);
  if (taskId && TASK_ID_PATTERN.test(taskId)) {
    window.sessionStorage.setItem(DATABASE_RESTART_TASK_KEY, taskId);
    return;
  }
  window.sessionStorage.removeItem(DATABASE_RESTART_TASK_KEY);
}
