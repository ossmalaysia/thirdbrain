import { expect, test } from "bun:test";
import { planFolders } from "../src/folders.ts";

const all = [{ id: "inbox-id", kind: "inbox" }, { id: "sent-id", kind: "sentitems" },
  ...Array.from({ length: 38 }, (_, i) => ({ id: `f${i}`, kind: `f${i}` }))];

test("Inbox and Sent Items are read on every run, wherever the rotation is", () => {
  let offset = 0;
  for (let run = 0; run < 30; run++) {
    const plan = planFolders(all, offset, 3);
    expect(plan.folders.slice(0, 2).map(f => f.kind)).toEqual(["inbox", "sentitems"]);
    expect(plan.folders).toHaveLength(5);
    offset = plan.nextOffset;
  }
});

test("the other folders rotate 3 at a time and all get covered", () => {
  const seen = new Set<string>();
  let offset = 0;
  for (let run = 0; run < 13; run++) { const p = planFolders(all, offset, 3); p.folders.slice(2).forEach(f => seen.add(f.id)); offset = p.nextOffset; }
  expect(seen.size).toBe(38);
  expect(planFolders(all, 37, 3).folders.slice(2).map(f => f.id)).toEqual(["f37", "f0", "f1"]); // wraps
});

test("an old offset from the previous 40-folder rotation is still valid", () => {
  expect(planFolders(all, 33, 3).folders.slice(2).map(f => f.id)).toEqual(["f33", "f34", "f35"]);
  expect(planFolders(all, 99, 3).folders.slice(2).map(f => f.id)).toEqual(["f23", "f24", "f25"]);
});

test("a mailbox with only Inbox and Sent still works", () => {
  expect(planFolders(all.slice(0, 2), 5, 3)).toEqual({ folders: all.slice(0, 2), nextOffset: 0 });
});
