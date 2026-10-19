// Stage 7: write notes into the vault, commit only the connector's folder, refresh the index.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Note } from "../types.ts";
import { DEFAULT_INDEX_EXCLUDE } from "../config.ts";
import { ENTITY_DIR } from "./entities.ts";

export function readNote(root: string, relPath: string): string | null {
  const f = join(root, relPath);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
}

/** Writes notes; returns the ones whose content actually changed. */
export function writeNotes(root: string, notes: Note[]): Note[] {
  const changed: Note[] = [];
  for (const n of notes) {
    const f = join(root, n.relPath);
    if (existsSync(f) && readFileSync(f, "utf8") === n.content) continue;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(`${f}.tmp`, n.content);
    renameSync(`${f}.tmp`, f);
    changed.push(n);
  }
  return changed;
}

function run(cmd: string[], cwd: string): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
  return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
}

/** The path of one `git status --porcelain` line. `run` trims the output, so the FIRST line can lose the leading
 *  space of its two-letter status (" M path" -> "M path"); cutting a fixed 3 characters then gave "nbox/..." and the
 *  run committed nothing ("no changes added to commit", 2026-10-18). A rename keeps its new path. */
export function porcelainPath(line: string): string {
  const p = line.replace(/^\s*[MADRCU?! ]{1,2}\s+/, "");
  return (p.includes(" -> ") ? p.slice(p.lastIndexOf(" -> ") + 4) : p).replace(/^"|"$/g, "");
}

/** Folders this connector writes and commits: email, Teams (chats + channels) and meetings. */
export const OWNED_DIRS = ["inbox/email", "inbox/teams", "inbox/meetings", "inbox/ai"];
export const OWNED_DIR = OWNED_DIRS[0];
/** Committed as well: the entity pages the sync keeps (core/entities.ts). Not a note folder. */
export const COMMIT_DIRS = [...OWNED_DIRS, ENTITY_DIR];

/** Commits everything pending under the connector's own folders (this run's notes plus any
 *  left over from a failed commit), then refreshes the index. Never touches other paths. */
export function commitAndIndex(brainPath: string, notes: Note[], execute = run, exclude: string[] = DEFAULT_INDEX_EXCLUDE): { committed: boolean; indexed: boolean; detail: string } {
  const pending = execute(["git", "status", "--porcelain", "--", ...COMMIT_DIRS], brainPath);
  if (pending.code !== 0) return { committed: false, indexed: false, detail: `git status: ${pending.out}` };
  const count = pending.out.split("\n").length;
  const msg = `mailsync: ${notes.length} new/updated, ${count} file change${count === 1 ? "" : "s"}`;
  if (pending.out) {
    // Only folders with changes: `git add` fails on a pathspec that doesn't exist yet (e.g. no Teams notes so far).
    const dirs = COMMIT_DIRS.filter(dir => pending.out.split("\n").some(line => porcelainPath(line).startsWith(`${dir}/`)));
    const add = execute(["git", "add", "--", ...dirs], brainPath);
    if (add.code !== 0) return { committed: false, indexed: false, detail: `git add: ${add.out}` };
    const commit = execute(["git", "commit", "-q", "-m", msg, "--", ...dirs], brainPath);
    if (commit.code !== 0) return { committed: false, indexed: false, detail: `git commit: ${commit.out}` };
  }
  const gbrain = join(process.env.USERPROFILE ?? "", ".bun", "bin", "gbrain.exe");
  // Retry indexing even when an earlier run already committed all files.
  const sync = execute([existsSync(gbrain) ? gbrain : "gbrain", "sync", "--source", "brain", "--no-pull", "--no-embed",
    ...exclude.flatMap(glob => ["--exclude", glob])], brainPath);
  return { committed: true, indexed: sync.code === 0, detail: sync.code === 0 ? (pending.out ? msg : "index refreshed") : "gbrain sync failed; indexing will retry next run" };
}
