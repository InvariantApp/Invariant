import { library } from "../../tsdown.shared.ts";

export default library({
  // The check against a release runs in a thread of its own, from its own file.
  entry: ["src/index.ts", "src/check.ts"],
  // Read at run time and written into the consumer's repository as it is.
  copy: [{ from: "src/templates/units.ts", to: "dist/templates" }],
});
