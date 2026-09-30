// Builds the synthetic tree the dedup benchmark walks. Run separately from the
// measured run so tree construction does not pollute the syscall trace.
//
//   node bench/make-tree.mjs <root> [leaves]

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
const leaves = Number(process.argv[3] ?? 300);
if (!root) throw new Error("usage: make-tree.mjs <root> [leaves]");

const SHARED = ["", "pkg", join("pkg", "sub")];
const body = (name) =>
  `# ${name}\n\nShared guidance for ${name}.\n\n- rule one\n- rule two\n`;

await mkdir(join(root, "pkg", "sub"), { recursive: true });
for (const rel of SHARED) {
  await writeFile(join(root, rel, "AGENTS.md"), body(rel || "root"));
}

for (let i = 0; i < leaves; i++) {
  const leaf = join(root, "pkg", "sub", `leaf-${i}`);
  await mkdir(leaf, { recursive: true });
  await writeFile(join(leaf, "AGENTS.md"), body(`leaf-${i}`));
  await writeFile(join(leaf, "probe.txt"), "probe\n");
}

console.log(`tree ready: ${root} (${leaves} leaves, ${leaves + 3} context files)`);
