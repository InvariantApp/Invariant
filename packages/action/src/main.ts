/**
 * The action's entry point, as GitHub runs it.
 */
import { runAction } from "./index.ts";

process.exitCode = await runAction(process.env)
  .then((result) => result.exitCode)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `::error title=The check could not run::${message.replaceAll("\n", "%0A")}\n`,
    );
    return 1;
  });
