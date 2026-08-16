const BACKUP_STATE_UNAVAILABLE = "The console could not verify this base's backup state. No changes were made. Try again after the database is available.";

// Base mutations must fail closed. Treating a failed backup-state query as
// "not backed up" could allow a stale or picked-up base to be changed through
// a direct API request while the console cannot prove that it is safe.
export async function verifyBaseBackupState(duneDb, db, baseId) {
  try {
    return await duneDb.baseIsBackedUp(db, baseId);
  } catch (cause) {
    const error = new Error(BACKUP_STATE_UNAVAILABLE, { cause });
    error.statusCode = 503;
    throw error;
  }
}
