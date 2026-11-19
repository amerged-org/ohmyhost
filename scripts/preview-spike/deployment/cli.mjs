/* global console */
import process from "node:process";
import { execute, safeDiagnostic } from "./deployment.mjs";

// Paths carry only private journal locations, never credentials or private scope values.
const [stage, ...args] = process.argv.slice(2);
if (!stage || args.length % 2 !== 0) {
  console.error(
    "usage: node scripts/preview-spike/deployment/cli.mjs <stage> --journal <absolute-private-path> [--resources <absolute-private-path>]",
  );
  process.exitCode = 1;
} else {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!["--journal", "--resources"].includes(name) || Object.hasOwn(options, name)) {
      console.error("invalid_arguments");
      process.exit(1);
    }
    options[name] = args[index + 1];
  }
  try {
    const result = await execute({
      stage,
      journalPath: options["--journal"],
      resourcesPath: options["--resources"],
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    // Only fixed internal codes may leave; provider and command diagnostics may contain secrets.
    console.error(`${safeDiagnostic(error)}; inspect the private journal before retrying`);
    process.exitCode = 1;
  }
}
