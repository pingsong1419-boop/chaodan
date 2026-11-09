import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const project = process.cwd();
const outputs = path.dirname(project);
const now = new Date();
const versionDate = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
const packageName = `订单抄单自动化-图形界面版-${versionDate}`;
const destination = path.join(outputs, `${packageName}.zip`);
const prefix = `${packageName}/`;

const entries = [];
function addFile(source, target) {
  entries.push({ source, target: prefix + target.replaceAll("\\", "/") });
}
function addTree(sourceDir, targetDir, filter = () => true) {
  for (const item of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, item.name);
    const target = path.join(targetDir, item.name);
    if (!filter(source, item)) continue;
    if (item.isDirectory()) addTree(source, target, filter);
    else addFile(source, target);
  }
}

addTree(path.join(project, "src"), "src", (source) => !/index\.(?:corrupted-backup|baseline-serial-).*\.js$/i.test(source));
addTree(path.join(project, "node_modules"), "node_modules");
for (const name of ["knowledge-rules.json", "material-map.json", "selection-catalog.index.json", "selection-catalog.summary.json", "motor-remote-authority.json"]) {
  addFile(path.join(project, "data", name), path.join("data", name));
}
addTree(path.join(project, "ai"), "ai", (source, item) => item.isDirectory() ? false : /\.mjs$|config\.example\.json$/.test(item.name));
for (const name of ["package.json", "package-lock.json", "config.json", "config.example.json", "迁移使用说明.txt"]) {
  addFile(path.join(project, name), name);
}
addFile(path.join(project, "订单抄单自动化.exe"), "订单抄单自动化.exe");
addFile("C:\\Program Files\\nodejs\\node.exe", path.join("runtime", "node.exe"));

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c >>> 0;
}
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const localParts = [];
const centralParts = [];
let offset = 0;
for (const entry of entries) {
  const raw = fs.readFileSync(entry.source);
  const compressed = zlib.deflateRawSync(raw, { level: 9 });
  const name = Buffer.from(entry.target, "utf8");
  const crc = crc32(raw);
  const stamp = dosTime(fs.statSync(entry.source).mtime);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(stamp.time, 10);
  local.writeUInt16LE(stamp.day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, name, compressed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(stamp.time, 12);
  central.writeUInt16LE(stamp.day, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, name);
  offset += local.length + name.length + compressed.length;
}

const centralData = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralData.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);
fs.writeFileSync(destination, Buffer.concat([...localParts, centralData, end]));
console.log(JSON.stringify({ destination, files: entries.length, bytes: fs.statSync(destination).size }));
