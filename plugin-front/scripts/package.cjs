"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const JSZip = require("jszip");

async function addDirectory(zip, directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await addDirectory(zip.folder(entry.name), fullPath);
    else zip.file(entry.name, await fs.readFile(fullPath));
  }
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const zip = new JSZip();
  zip.file("plugin.json", await fs.readFile(path.join(root, "plugin.json")));
  await addDirectory(zip.folder("resource"), path.join(root, "dist"));
  await addDirectory(zip.folder("node"), path.join(root, "../plugin-node-dev/dist"));
  await fs.mkdir(path.join(root, "build"), { recursive: true });
  await fs.writeFile(path.join(root, "build/agent.zip"), await zip.generateAsync({ type: "nodebuffer" }));
  process.stdout.write("已生成 build/agent.zip\n");
}
main().catch(error => {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
});
