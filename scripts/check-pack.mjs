// Validate the npm tarball contents: everything needed to run, nothing else.
import { execFileSync } from "node:child_process";

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
const [info] = JSON.parse(out);
const files = info.files.map((f) => f.path);
const problems = [];

for (const required of [
  "package.json",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CHANGELOG.md",
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
]) {
  if (!files.includes(required)) problems.push(`missing ${required}`);
}
for (const f of files) {
  if (/^(src|tests|scripts|docs|examples|\.github)\//.test(f)) problems.push(`unexpected ${f}`);
  if (/\.map$/.test(f)) problems.push(`source map shipped: ${f}`);
  if (/(^|\/)\.env/.test(f) || /\.tgz$/.test(f)) problems.push(`sensitive/unwanted file: ${f}`);
}
const cli = info.files.find((f) => f.path === "dist/cli.js");
if (cli && (cli.mode & 0o111) === 0) problems.push("dist/cli.js is not executable");
if (info.size > 200_000) problems.push(`tarball unexpectedly large: ${info.size} bytes`);

if (problems.length) {
  console.error(`package check failed:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  `package check ok: ${info.name}@${info.version}, ${files.length} files, ${info.size} bytes packed`,
);
