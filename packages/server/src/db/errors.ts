/** Why the database could not be set up, as the status screen and CLI name it. */
export type SetupProblem =
  | "database_locked"
  | "database_unreachable"
  | "database_underprivileged"
  | "database_too_old"
  | "app_schema_newer"
  | "migration_altered"
  | "migration_failed";

export class DatabaseSetupError extends Error {
  constructor(
    readonly code: SetupProblem,
    message: string,
  ) {
    super(message);
    this.name = "DatabaseSetupError";
  }
}
