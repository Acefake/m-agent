"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

async function main() {
  const source = path.resolve(__dirname, "../dist");
  const target = path.resolve(__dirname, "../../plugin-front/.temp/buildNode");
  await fs.mkdir(target, { recursive: true });
  await fs.cp(source, target, { recursive: true });
  process.stdout.write("已同步 Node 产物到 plugin-front/.temp/buildNode\n");
}
main().catch(error => {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
});
