// Encrypted JSON files for local credentials (ChatGPT tokens, Cloudflare tunnel token).
// AES-256-GCM with a random key in secret.key beside the file, in ~/.brain-mailsync (outside the vault).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicJson, readJson } from "../docker/scheduler.mjs";

function secretKey(file: string): Buffer {
  const path = join(dirname(file), "secret.key");
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    try { writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" }); } catch { /* another process created it first */ }
  }
  return readFileSync(path);
}

/** Writes `value` encrypted to `file`; null deletes the file. */
export function saveSecret(file: string, value: unknown | null): void {
  if (value === null) { rmSync(file, { force: true }); return; }
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secretKey(file), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  atomicJson(file, { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}

/** Reads an encrypted file; a missing, tampered or foreign-key file reads as null. */
export function loadSecret<T>(file: string): T | null {
  const box = readJson(file);
  if (box?.v !== 1) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", secretKey(file), Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8"));
  } catch { return null; }
}
