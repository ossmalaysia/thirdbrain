import { expect, test } from "bun:test";
import { HEADERS, RESCAN, listFolders, pullFolder, scanUrl } from "../src/adapters/outlook.ts";
import type { Config } from "../src/state.ts";
const cfg: Config = { brainPath: "unused", clientId: "unused", tenantId: "unused", model: "", maxThreadsPerRun: 25, initialSinceDays: 10, maxPagesPerFolder: 1 };

test("bounded paging checkpoints and resumes, with immutable IDs on every request", async () => {
  const requests: string[] = [];
  const get = async (_: Config, url: string, headers?: Record<string, string>) => {
    expect(headers).toEqual(HEADERS);
    requests.push(url);
    return url === "https://graph.microsoft.com/v1.0/next" ?
      { value: [{ id: "two", conversationId: "t", receivedDateTime: "2026-10-12T00:00:00Z" }] } :
      { value: [{ id: "one", conversationId: "t", receivedDateTime: "2026-10-13T00:00:00Z" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" };
  };
  const first = await pullFolder(cfg, "folder-id", undefined, "2026-10-04T00:00:00Z", "sentitems", get);
  expect(first.items[0].folder).toBe("sentitems");
  expect(first.next).toBe("https://graph.microsoft.com/v1.0/next");
  const second = await pullFolder(cfg, "folder-id", first.next, "2026-10-04T00:00:00Z", "sentitems", get);
  expect(second.items[0].id).toBe("two");
  expect(second.next).toBe(RESCAN);
  expect(requests).toHaveLength(2);
  expect(decodeURIComponent(requests[0]).replace(/\+/g, " ")).toContain("receivedDateTime ge 2026-10-04T00:00:00Z");
});

test("folder discovery includes nested/custom folders and excludes localized junk/deleted/drafts", async () => {
  const get = async (_: Config, url: string) => {
    for (const kind of ["junkemail", "deleteditems", "drafts", "sentitems", "inbox"]) if (url.includes(`/mailFolders/${kind}?`)) return { id: kind };
    if (url.includes("/childFolders")) return { value: [{ id: "nested", displayName: "Project", childFolderCount: 0 }] };
    return { value: [
      ...["junkemail", "deleteditems", "drafts", "sentitems"].map(id => ({ id, displayName: "localized", childFolderCount: 0 })),
      { id: "custom", displayName: "Customers", childFolderCount: 1 },
    ] };
  };
  const folders = await listFolders(cfg, get);
  expect(folders.map(f => f.id)).toEqual(["sentitems", "custom", "nested"]);
  expect(folders[0].kind).toBe("sentitems");
});

test("history uses paginated messages, avoiding Graph filtered delta's 5,000-message cap", () => {
  expect(scanUrl("folder", "2026-09-14T00:00:00Z")).toContain("/messages?");
  expect(scanUrl("folder", "2026-09-14T00:00:00Z")).not.toContain("/delta");
});
