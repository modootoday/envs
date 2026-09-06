/**
 * Hex and SHA-256, in one place. Written out three times they drift, and a
 * digest that drifts is a digest two sides disagree about.
 */

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A detached copy: a view onto a larger buffer would hash the whole of it.
  const copy = bytes.slice();
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy)));
}
