import { library } from "../../tsdown.shared.ts";

export default library({
  // Read at run time and written into the consumer's repository as it is.
  copy: [{ from: "src/templates/units.ts", to: "dist/templates" }],
});
