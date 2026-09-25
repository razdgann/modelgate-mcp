import { chmodSync, readFileSync } from "node:fs";
const cli = new URL("../dist/cli.js", import.meta.url);
if (!readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node")) {
  throw new Error("dist/cli.js lost its shebang");
}
chmodSync(cli, 0o755);
