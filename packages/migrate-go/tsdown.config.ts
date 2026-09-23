import { library } from "../../tsdown.shared.ts";

export default library({
  // The Go helper ships as source and is built on first use with the
  // consumer's own toolchain, which a Go repository has by definition.
  copy: [
    {
      from: [
        "../../engines/go/migrate/*.go",
        "!../../engines/go/migrate/*_test.go",
        "../../engines/go/migrate/go.mod",
        "../../engines/go/migrate/go.sum",
      ],
      to: "dist/helper",
    },
  ],
});
