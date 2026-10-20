import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Personal values of the person this code was extracted from must never come back. The tokens are assembled at run
// time so this file does not contain them itself.
const TOKENS = [["ja", "zz"], ["anchor", "sprint"], ["athen", "mark"], ["tail15", "cb45"], ["grol", "ier"], ["silver", "lake"]].map(p => p.join(""));
const PATTERN = new RegExp([...TOKENS, "D:(?:\\\\{1,2}|/)" + "brain\\b"].join("|"), "i");

const ROOT = join(import.meta.dir, "..", "..");
const SCAN = ["app/src", "app/scripts", "app/portal", "app/test", "app/docker", "app/package.json", "app/config.example.json", "docs", "scripts", "README.md"];
const TEXT = /\.(ts|js|mjs|json|html|css|md|txt|ps1|yml|yaml|toml|svg)$/i;

function files(path: string): string[] {
  let st;
  try { st = statSync(path); } catch { return []; }
  if (st.isFile()) return TEXT.test(path) ? [path] : [];
  return readdirSync(path).filter(n => n !== "node_modules").flatMap(n => files(join(path, n)));
}

test("no personal names, addresses, domains or paths in code, tests, docs or scripts", () => {
  const hits = SCAN.flatMap(p => files(join(ROOT, p))).flatMap(file => readFileSync(file, "utf8").split(/\r?\n/)
    .flatMap((line, i) => PATTERN.test(line) ? [`${relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`] : []));
  expect(hits).toEqual([]);
});
