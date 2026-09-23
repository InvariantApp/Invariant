/**
 * What a Change does, in the words a pull request shows a reviewer, the same
 * whichever language pack found the site.
 */
import type { Codec } from "@invariant-app/ir";

/** What a re-encoding does to a value, in a reviewer's words. */
export function recoding(codec: Codec): string {
  switch (codec.kind) {
    case "scale10":
      return `the value times 10^${codec.exponent}`;
    case "enumMap":
      return "a renamed value";
    case "cast":
      return `${codec.to === "integer" ? "an" : "a"} ${codec.to} instead of ${codec.from === "integer" ? "an" : "a"} ${codec.from}`;
    case "dateFormat":
      return `${codec.to} instead of ${codec.from}`;
    case "stringCase":
      return `${codec.to} case instead of ${codec.from} case`;
    case "wrapArray":
      return "a list of one instead of the value";
    case "unwrapSingle":
      return "the one item instead of a list";
    case "dropValues":
      return `a list that no longer accepts ${codec.values
        .slice(0, 3)
        .map((value) => `\`${value}\``)
        .join(
          ", ",
        )}${codec.values.length > 3 ? ` and ${codec.values.length - 3} more` : ""}`;
  }
}
