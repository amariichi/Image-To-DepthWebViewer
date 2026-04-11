import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const targets = [path.join(root, "webapp", "src")];
const files = [];

function collectJsFiles(entryPath) {
  const stats = statSync(entryPath);
  if (stats.isDirectory()) {
    for (const child of readdirSync(entryPath)) {
      collectJsFiles(path.join(entryPath, child));
    }
    return;
  }
  if (entryPath.endsWith(".js")) {
    files.push(entryPath);
  }
}

for (const target of targets) {
  collectJsFiles(target);
}

files.sort();

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log(`Checked ${files.length} JavaScript files.`);
