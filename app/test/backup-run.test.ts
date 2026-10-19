import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVaultBackup, type Exec } from "../src/backup.ts";


// Commit identity for the fixture repos (inherited by the git processes the backup starts); no signing prompts.
Object.assign(process.env, { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" });

const git = (args: string[], cwd: string) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim() };
};
/** A repo of its own with a local identity: a clean machine (CI) has no global git user, and the backup commits. */
const initRepo = (cwd: string) => { git(["init", "-q", "-b", "main"], cwd); git(["config", "user.name", "Test"], cwd); git(["config", "user.email", "test@example.com"], cwd); };
const now = new Date(2026, 9, 17, 9, 5);

test("backup commits the vault (never .env, ignored files or the local-only repo), pushes it, and commits the local-only repo locally", async () => {
  // Real git, all on disk: a vault, a bare "remote", a nested local-only repo, .env files and a gitignored file.
  const root = mkdtempSync(join(tmpdir(), "tb-backup-")), vault = join(root, "vault"), remote = join(root, "remote.git");
  git(["init", "-q", "--bare", "-b", "main", remote], root);
  mkdirSync(join(vault, "_setup"), { recursive: true });
  initRepo(vault);
  git(["remote", "add", "origin", remote], vault);
  writeFileSync(join(vault, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(vault, "note.md"), "# Note\n");
  writeFileSync(join(vault, "ignored.txt"), "skip\n");
  writeFileSync(join(vault, "_setup", ".env"), "SECRET=1\n");
  writeFileSync(join(vault, ".env"), "SECRET=1\n");
  mkdirSync(join(vault, "life"));
  initRepo(join(vault, "life"));
  writeFileSync(join(vault, "life", "private.md"), "private\n");

  expect(await runVaultBackup({ vault, push: true, localOnlyRepos: ["life"], now })).toBe(0);
  expect(git(["ls-files"], vault).out.split("\n").sort()).toEqual([".gitignore", "note.md"]);
  expect(git(["log", "-1", "--format=%s"], vault).out).toBe("backup: 2026-10-17 09:05");
  expect(git(["rev-parse", "main"], remote).out).toBe(git(["rev-parse", "HEAD"], vault).out);  // pushed
  expect(git(["ls-files"], join(vault, "life")).out).toBe("private.md");                      // committed in its own repo
}, 180_000); // git is slow on some Windows machines (antivirus on temp folders)

/** Records commands; `staged` decides what `git diff --cached --quiet` answers; `fail` lists commands that fail. */
function fake(staged: boolean, fail: string[] = []) {
  const calls: string[] = [];
  // check-ignore answers "not ignored" (1), the case where a local-only repo must be excluded explicitly.
  const run: Exec = async cmd => { const line = cmd.join(" "); calls.push(line); return fail.some(f => line.startsWith(f)) ? 1 : cmd[1] === "diff" ? (staged ? 1 : 0) : cmd[1] === "check-ignore" ? 1 : 0; };
  return { calls, run };
}

test("commands: excludes .env and local-only repos, commits only when something is staged, pushes every remote unless push is off", async () => {
  const vault = mkdtempSync(join(tmpdir(), "tb-cmds-"));
  mkdirSync(join(vault, "life", ".git"), { recursive: true });
  const a = fake(true);
  expect(await runVaultBackup({ vault, push: true, localOnlyRepos: ["life", "missing"], now }, a.run, async () => "origin\nbackup")).toBe(0);
  expect(a.calls).toEqual([
    "git check-ignore -q life", "git check-ignore -q missing",
    "git add -A -- . :(exclude,glob)**/.env :(exclude)life :(exclude)missing", "git diff --cached --quiet", "git commit -q -m backup: 2026-10-17 09:05",
    "git push -q origin HEAD", "git push -q backup HEAD",
    "git add -A -- . :(exclude,glob)**/.env", "git diff --cached --quiet", "git commit -q -m backup: 2026-10-17 09:05"]); // life: local only; missing: skipped
  const b = fake(false);
  expect(await runVaultBackup({ vault, push: false, localOnlyRepos: [], now }, b.run, async () => "origin")).toBe(0);
  expect(b.calls).toEqual(["git add -A -- . :(exclude,glob)**/.env", "git diff --cached --quiet"]); // nothing staged: no empty commit, no push
});

test("a failed push or commit marks the backup failed; the other steps still run", async () => {
  const vault = mkdtempSync(join(tmpdir(), "tb-fail-"));
  const a = fake(true, ["git push -q origin"]);
  expect(await runVaultBackup({ vault, push: true, localOnlyRepos: [], now }, a.run, async () => "origin second")).toBe(1);
  expect(a.calls).toContain("git push -q second HEAD");
  expect(await runVaultBackup({ vault, push: true, localOnlyRepos: [], now }, fake(true, ["git commit"]).run, async () => "")).toBe(1);
  expect(await runVaultBackup({ vault, push: true, localOnlyRepos: [], now }, fake(true).run, async () => null)).toBe(1); // remotes unreadable
});

test("restic runs only when configured, with the settings in its environment", async () => {
  const calls: { cmd: string[]; env?: Record<string, string | undefined> }[] = [];
  const run: Exec = async (cmd, _cwd, env) => { calls.push({ cmd, env }); return 0; };
  const vault = mkdtempSync(join(tmpdir(), "tb-restic-"));
  await runVaultBackup({ vault, push: false, localOnlyRepos: [], settings: {} }, run);
  expect(calls.some(c => c.cmd[0] === "restic")).toBe(false);
  await runVaultBackup({ vault, push: false, localOnlyRepos: [], settings: { RESTIC_REPOSITORY: "s3:example/bucket" } }, run);
  const restic = calls.find(c => c.cmd[0] === "restic")!;
  expect(restic.cmd).toEqual(["restic", "backup", vault, "--exclude", join(vault, ".gbrain"), "--tag", "brain"]);
  expect(restic.env?.RESTIC_REPOSITORY).toBe("s3:example/bucket");
});
