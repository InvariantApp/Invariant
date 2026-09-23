/**
 * A place a migration shows to a person instead of rewriting.
 *
 * Every language pack reports what it would not edit the same way, so the
 * pull request groups them by file and reason whatever language they are in.
 */
export interface ManualSite {
  file: string;
  line: number;
  column: number;
  changeId: string;
  reason: string;
  snippet: string;
  /**
   * Byte offset in the file as it was before any edit.
   *
   * Kept so the reported line can be moved to where the site ends up. A
   * migration that inserts an import shifts every line below it, and a report
   * that points a reviewer one line above the thing it is talking about is
   * worse than one that points nowhere.
   */
  offset: number;
  /** Where the flagged node ends, also before any edit, so a reviewer sees its extent. */
  end?: number;
}
