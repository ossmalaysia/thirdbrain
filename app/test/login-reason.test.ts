import { expect, test } from "bun:test";
import { loginLost } from "../src/adapters/graph.ts";

test("known Microsoft codes get a plain reason", () => {
  expect(loginLost({ error: "invalid_grant", error_codes: [50173] })).toEqual({ code: "AADSTS50173", reason: expect.stringContaining("password changed") });
  expect(loginLost({ error: "invalid_grant", error_codes: [700082] }).reason).toContain("not used for a long time");
  expect(loginLost({ error: "invalid_grant", error_codes: [70043] }).reason).toContain("policy");
  expect(loginLost({ error: "interaction_required", error_codes: [50076] }).reason).toContain("multi-factor");
});

test("unknown codes keep the code and Microsoft's error name", () => {
  expect(loginLost({ error: "invalid_grant", error_codes: [9999] })).toEqual({ code: "AADSTS9999", reason: "Microsoft refused the saved sign-in (invalid_grant)." });
  expect(loginLost({ error: "invalid_grant" }).code).toBe("invalid_grant");
  expect(loginLost({}).code).toBe("unknown_error");
});
