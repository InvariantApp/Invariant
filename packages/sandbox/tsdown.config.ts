import { library } from "../../tsdown.shared.ts";

// The proxy's entry is built beside the library because the drivers mount
// this directory into a container and start the proxy from there.
export default library({
  entry: ["src/index.ts", "src/proxy-main.ts"],
});
