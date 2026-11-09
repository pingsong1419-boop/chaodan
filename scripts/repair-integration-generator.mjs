import fs from "node:fs";
import path from "node:path";

const file = path.resolve(import.meta.dirname, "integrate-continuous-copy.mjs");
let source = fs.readFileSync(file, "utf8");

function extract(name, nextMarker) {
  const startMarker = `const ${name} = String.raw\``;
  const start = source.indexOf(startMarker);
  const end = source.indexOf(nextMarker, start);
  if (start < 0 || end < 0) throw new Error(`cannot extract ${name}`);
  const rawEnd = source.lastIndexOf("`;", end);
  const content = source.slice(start + startMarker.length, rawEnd);
  fs.writeFileSync(path.resolve(import.meta.dirname, `${name}.snippet.txt`), content, "utf8");
  source = source.slice(0, start) + `const ${name} = fs.readFileSync(path.resolve(import.meta.dirname, "${name}.snippet.txt"), "utf8");\n` + source.slice(rawEnd + 2);
}

extract("batchUi", "once(\n  `  document.addEventListener");
extract("coordinator", "once(\n  `function startCheckedOrderMonitor");
fs.writeFileSync(file, source, "utf8");
console.log("repaired integration generator");
