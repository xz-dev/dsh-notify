import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const store = join(homedir(), ".local/share/dsh/npm/node_modules/@deepseek-ai");
const dest = join(import.meta.dirname, "..", "node_modules", "@deepseek-ai");
if (!existsSync(store)) {
  console.log("skip peer links: DSH store missing");
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
for (const name of ["schemastery", "dsh-tools", "cordis"]) {
  const target = join(store, name);
  const link = join(dest, name);
  if (!existsSync(target) || existsSync(link)) continue;
  symlinkSync(target, link);
}
