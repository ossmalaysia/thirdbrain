import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { commitAndIndex, porcelainPath } from "../src/core/commit.ts";

test("real git commits only mail notes and failed indexing retries after a clean commit", () => {
  const root = mkdtempSync(join(tmpdir(), "mailsync-commit-"));
  const tempRoot = resolve(tmpdir());
  expect(resolve(root).startsWith(tempRoot + "\\") || resolve(root).startsWith(tempRoot + "/")).toBe(true);
  try {
    const real = (cmd: string[], cwd = root) => {
      const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
    };
    expect(real(["git", "init", "-q"]).code).toBe(0);
    real(["git", "config", "user.name", "Fixture"]);
    real(["git", "config", "user.email", "fixture@example.test"]);
    mkdirSync(join(root, "inbox/email"), { recursive: true });
    writeFileSync(join(root, "inbox/email/sample.md"), "# Synthetic mail note\n");
    writeFileSync(join(root, "unrelated.md"), "Leave this unstaged\n");
    let syncs = 0;
    const execute = (cmd: string[], cwd: string) => {
      if (cmd[1] !== "sync") return real(cmd, cwd);
      syncs++;
      expect(cmd).toContain("life/**");
      expect(cmd).toContain("clients/**"); // configured (config.json vault.indexExclude)
      return { code: syncs === 1 ? 1 : 0, out: "fixture index result" };
    };
    expect(commitAndIndex(root, [], execute, ["life/**", "clients/**"])).toMatchObject({ committed: true, indexed: false });
    expect(real(["git", "ls-files"]).out.trim()).toBe("inbox/email/sample.md");
    const revision = real(["git", "rev-parse", "HEAD"]).out.trim();
    expect(commitAndIndex(root, [], execute, ["life/**", "clients/**"])).toMatchObject({ committed: true, indexed: true });
    expect(real(["git", "rev-parse", "HEAD"]).out.trim()).toBe(revision);
    expect(syncs).toBe(2);
    expect(existsSync(join(root, "unrelated.md"))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("entity pages are committed with the notes", () => {
  const root = mkdtempSync(join(tmpdir(), "mailsync-commit-"));
  try {
    const real = (cmd: string[], cwd = root) => {
      const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
    };
    real(["git", "init", "-q"]);
    real(["git", "config", "user.name", "Fixture"]);
    real(["git", "config", "user.email", "fixture@example.test"]);
    mkdirSync(join(root, "inbox/entities/people"), { recursive: true });
    writeFileSync(join(root, "inbox/entities/people/jane-lim.md"), "# Jane Lim\n");
    const execute = (cmd: string[], cwd: string) => cmd[1] === "sync" ? { code: 0, out: "" } : real(cmd, cwd);
    expect(commitAndIndex(root, [], execute)).toMatchObject({ committed: true, indexed: true });
    expect(real(["git", "ls-files"]).out.trim()).toBe("inbox/entities/people/jane-lim.md");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("porcelainPath: the first line of trimmed output, staged, untracked, quoted and renamed paths", () => {
  expect(porcelainPath("M inbox/ai/claude/a.md")).toBe("inbox/ai/claude/a.md");      // " M" after the trim
  expect(porcelainPath(" M inbox/ai/claude/a.md")).toBe("inbox/ai/claude/a.md");
  expect(porcelainPath("M  inbox/email/b.md")).toBe("inbox/email/b.md");
  expect(porcelainPath("?? inbox/teams/c.md")).toBe("inbox/teams/c.md");
  expect(porcelainPath('?? "inbox/ai/d e.md"')).toBe("inbox/ai/d e.md");
  expect(porcelainPath("R  inbox/old.md -> inbox/entities/new.md")).toBe("inbox/entities/new.md");
});

test("commit: a changed note as the only change is committed (the trimmed first line)", () => {
  const calls: string[][] = [];
  const execute = (cmd: string[]) => { calls.push(cmd); return cmd[1] === "status" ? { code: 0, out: "M inbox/ai/claude/2026-09/n.md" } : { code: 0, out: "" }; };
  expect(commitAndIndex("D:/vault", [], execute as any, [])).toMatchObject({ committed: true });
  expect(calls.find(c => c[1] === "add")).toEqual(["git", "add", "--", "inbox/ai"]);
  expect(calls.find(c => c[1] === "commit")?.slice(-2)).toEqual(["--", "inbox/ai"]);
});
