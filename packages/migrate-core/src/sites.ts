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
   * Offset in the file as it was before any edit, as its text is indexed
   * here: in UTF-16 code units, not bytes (a pack whose compiler counts bytes
   * converts with `Offsets`).
   *
   * Kept so the reported line can be moved to where the site ends up. A
   * migration that inserts an import shifts every line below it, and a report
   * that points a reviewer one line above the thing it is talking about is
   * worse than one that points nowhere.
   */
  offset: number;
  /** Where the flagged node ends, also before any edit, so a reviewer sees its extent. */
  end?: number;
  /**
   * Where the changed element itself is written, as an offset like `offset`,
   * where what is shown is wider than it: the read of a moved field inside
   * the ten-line statement a reviewer is shown, or the name of a class the
   * upgrade removed inside the call that builds one. Left out where the site
   * starts at the element.
   */
  at?: number;
}
