import crypto from "node:crypto";

export function buildSandboxClientOid(internalSignalId: string): string {
  const value = internalSignalId.trim();
  if (!value) throw new Error("internalSignalId must not be empty");
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}