import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const inGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root }).status === 0;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [relative(root, path)];
  });
}

// The image is built from a git clone. A source file that .gitignore swallows works on this
// machine and fails on the server: `data/` once hid server/src/data/, and the local build passed.
describe("repository", () => {
  it.skipIf(!inGit)("does not ignore any source, test or script file", () => {
    const files = ["server/src", "server/test", "server/scripts", "web/src", "web/test", "web/e2e"]
      .flatMap((d) => filesUnder(join(root, d)));
    expect(files.length).toBeGreaterThan(50);
    const r = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: root, input: files.join("\n"), encoding: "utf8" });
    expect(r.stdout.trim().split("\n").filter(Boolean)).toEqual([]); // what git prints is what it ignores
  });
});
