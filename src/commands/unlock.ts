import { readFileSync } from "node:fs";

import type { Unlock } from "../crypto/keyring.js";

function readStdin(): string {
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * A secret on the command line is visible to every process on the machine and
 * lands in shell history, so stdin and the environment come first. Returns a
 * message rather than throwing: the caller decides how to say it.
 */
export function resolveUnlock(
  code: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Unlock | string {
  const fromArg = code === "-" ? readStdin() : code;
  const recovery = fromArg ?? env["ENVS_RECOVERY_CODE"] ?? "";
  if (recovery !== "") return { recoveryCode: recovery };

  const kek = env["ENVS_KEK"] ?? "";
  if (kek === "") {
    return "no key given: pass --recovery-code -, or set ENVS_RECOVERY_CODE or ENVS_KEK";
  }
  const bytes = new Uint8Array(Buffer.from(kek, "base64"));
  if (bytes.length !== 32) return "ENVS_KEK must be 32 bytes, base64 encoded";
  return { kek: bytes };
}
