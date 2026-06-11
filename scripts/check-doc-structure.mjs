import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const docPath = "doc/02-架构/02-实现计划与代码结构.md";
const doc = readFileSync(docPath, "utf8");
const roots = ["apps", "packages", "plugins"];
const missing = [];

for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const relative = `${root}/${entry.name}`;
    if (!doc.includes(`## ${relative}`)) {
      missing.push(relative);
    }
  }
}

if (missing.length > 0) {
  console.error(`${docPath} is missing sections for: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`${docPath} matches current top-level business directories.`);
