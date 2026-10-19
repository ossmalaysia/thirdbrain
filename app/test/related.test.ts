import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyRelated, linkRelated, loadVectors, noteDoc, ollamaEmbed, refreshVectors, relatedFor, type Embed } from "../src/core/related.ts";
import { rebuildRelated, relatedForRun } from "../src/related-rebuild.ts";

const note = (title: string, summary: string, tags: string[] = ["ai-chat"]) =>
  `---\ntitle: ${JSON.stringify(title)}\ncreated: 2026-09-01\nsource: chatgpt-sync\ntags: ${JSON.stringify(tags)}\n---\n\n# ${title}\n\n## Summary\n${summary}\n\n## Links\n- [Open](https://x)\n`;

/** Fake model: the vector is fixed by the first word of the summary line (same word = same subject). */
const SUBJECT: Record<string, number[]> = { datadog: [1, 0, 0], terraform: [0.8, 0.6, 0], recipe: [0, 0, 1] };
const fakeEmbed: Embed = async texts => texts.map(t => {
  const word = t.split("\n")[1]?.split(" ")[0]?.toLowerCase() ?? "";
  const v = SUBJECT[word] ?? [0, 1, 0], n = Math.hypot(...v);
  return Float32Array.from(v, x => x / n);
});

function vault(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "tb-related-"));
  for (const [rel, c] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), c); }
  return { root, cache: join(root, "vectors.json"), read: (rel: string) => readFileSync(join(root, rel), "utf8") };
}

test("noteDoc: title and summary only; personal flag from tags", () => {
  const d = noteDoc("inbox/ai/chatgpt/a.md", note("Capacity report", "Datadog review.", ["personal"]))!;
  expect(d).toEqual({ slug: "inbox/ai/chatgpt/a", title: "Capacity report", text: "Capacity report\nDatadog review.", personal: true });
  expect(noteDoc("x.md", "no frontmatter")).toBeNull();
});

test("applyRelated: a section before Links, replaced on the next run, removed when empty; CRLF kept", () => {
  const base = note("A", "Datadog x");
  const once = applyRelated(base, [{ slug: "inbox/ai/b", title: "B [draft]" }]);
  expect(once).toContain("## Related notes\n- [[inbox/ai/b|B draft]]\n\n## Links");
  expect(applyRelated(once, [{ slug: "inbox/ai/b", title: "B [draft]" }])).toBe(once);
  expect(applyRelated(once, [])).toBe(base);
  expect(applyRelated(base.replace(/\n/g, "\r\n"), [{ slug: "s", title: "S" }])).toContain("## Related notes\r\n- [[s|S]]\r\n");
});

test("relatedFor: the floor, the cap, best first, never itself or a skipped note", () => {
  const v = (a: number[]) => { const n = Math.hypot(...a); return Float32Array.from(a, x => x / n); };
  const vectors = new Map([["a", v([1, 0])], ["b", v([0.99, 0.1])], ["c", v([0.9, 0.44])], ["d", v([0, 1])], ["p", v([1, 0.01])]]);
  expect(relatedFor("a", vectors, new Set(["p"]), 0.82, 3).map(r => r.slug)).toEqual(["b", "c"]);
  expect(relatedFor("a", vectors, new Set(), 0.82, 1).map(r => r.slug)).toEqual(["p"]);
});

test("rebuild: similar notes link each other, unrelated and personal ones do not; second run changes nothing", async () => {
  const v = vault({
    "inbox/ai/chatgpt/2025-01/dd1.md": note("Capacity report", "Datadog capacity email"),
    "inbox/ai/claude/2026-05/dd2.md": note("Northwind attestation", "Datadog data handling"),
    "inbox/ai/chatgpt/2025-02/tf.md": note("Run hygiene", "Terraform unattended runs"),
    "inbox/ai/chatgpt/2025-03/food.md": note("Dinner", "Recipe for laksa"),
    "inbox/ai/chatgpt/2025-04/me.md": note("Private", "Datadog personal", ["personal"]),
    "inbox/entities/topics/datadog.md": note("Datadog", "Datadog topic page"),
  });
  const r = await rebuildRelated(v.root, { dryRun: false, embed: fakeEmbed, cacheFile: v.cache });
  expect(r).toMatchObject({ notes: 5, embedded: 5 });
  const dd1 = v.read("inbox/ai/chatgpt/2025-01/dd1.md");
  expect(dd1).toContain("[[inbox/ai/claude/2026-05/dd2|Northwind attestation]]");
  expect(dd1).not.toContain("me|Private");                // personal: never a target
  expect(dd1).not.toContain("entities/topics");            // entity pages are not notes
  expect(v.read("inbox/ai/chatgpt/2025-03/food.md")).not.toContain("## Related notes");
  expect(v.read("inbox/ai/chatgpt/2025-04/me.md")).not.toContain("## Related notes");
  expect(v.read("inbox/ai/claude/2026-05/dd2.md")).toContain("dd1|Capacity report]]");
  const again = await rebuildRelated(v.root, { dryRun: false, embed: fakeEmbed, cacheFile: v.cache });
  expect(again).toMatchObject({ embedded: 0, notesChanged: 0 });
});

test("sync step: a new note links known notes from the cache; only changed texts are embedded", async () => {
  const v = vault({ "inbox/ai/chatgpt/2025-01/dd1.md": note("Capacity report", "Datadog capacity email") });
  await rebuildRelated(v.root, { dryRun: false, embed: fakeEmbed, cacheFile: v.cache });
  let calls = 0;
  const counting: Embed = async t => { calls += t.length; return fakeEmbed(t); };
  const [out] = await relatedForRun([{ relPath: "inbox/ai/chatgpt/2026-10/new.md", content: note("New review", "Datadog cost review") }], { embed: counting, cacheFile: v.cache });
  expect(out.content).toContain("[[inbox/ai/chatgpt/2025-01/dd1|Capacity report]]");
  expect(calls).toBe(1);
  expect(Object.keys(loadVectors(v.cache).items)).toHaveLength(2);
});

test("ollamaEmbed: batches, unit vectors, clear error", async () => {
  const seen: number[] = [];
  const fake = (async (_u: string, init: any) => { const n = JSON.parse(init.body).input.length; seen.push(n); return Response.json({ embeddings: Array.from({ length: n }, () => [3, 4]) }); }) as any;
  const out = await ollamaEmbed("http://x", fake)(Array.from({ length: 40 }, (_, i) => `t${i}`));
  expect(seen).toEqual([32, 8]);
  expect([...out[0]].map(x => +x.toFixed(2))).toEqual([0.6, 0.8]);
  await expect(ollamaEmbed("http://x", (async () => new Response("", { status: 404 })) as any)(["a"])).rejects.toThrow("Ollama");
});

test("linkRelated + refreshVectors: a note dropped from the vault leaves the cache on a full refresh", async () => {
  const cache = { model: "nomic-embed-text", items: {} } as ReturnType<typeof loadVectors>;
  const a = noteDoc("n/a.md", note("A", "Datadog a"))!, b = noteDoc("n/b.md", note("B", "Datadog b"))!;
  await refreshVectors(cache, [a, b], fakeEmbed, { all: true });
  expect(linkRelated([{ relPath: "n/a.md", content: note("A", "Datadog a") }], cache)[0].links).toBe(1);
  await refreshVectors(cache, [a], fakeEmbed, { all: true });
  expect(Object.keys(cache.items)).toEqual(["n/a"]);
});
