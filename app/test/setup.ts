// Test preload (bunfig.toml): every test run gets its own empty state directory, so no test can read or
// write a real install's state, settings or tokens. Runs before any test file imports src/state.ts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const key of ["THIRDBRAIN_STATE_DIR", "THIRDBRAIN_CONFIG", "BRAIN_PATH", "MAILSYNC_CLIENT_ID", "MAILSYNC_TENANT_ID", "RESTIC_REPOSITORY"]) delete process.env[key];
process.env.MAILSYNC_STATE_DIR = mkdtempSync(join(tmpdir(), "thirdbrain-test-state-"));
