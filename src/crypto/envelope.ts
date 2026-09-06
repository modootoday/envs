/**
 * AES-GCM envelope, synchronous because config() is a side-effect import and
 * cannot await. The header is authenticated as AAD together with a caller
 * context, so a valid blob cannot be replayed into another position.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

export const MAGIC = new Uint8Array([0x45, 0x4e, 0x56, 0x43]); // "ENVC"

/** Algorithm agility. One value today; without the field there is no second. */
export const FORMAT_AES_256_GCM = 1;

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEK_BYTES = 32;
const HEADER_FIXED = MAGIC.length + 1 + 4 + 1;

export class EnvelopeFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeFormatError";
  }
}

export class EnvelopeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeAuthError";
  }
}

export interface EnvelopeHeader {
  readonly format: number;
  readonly kekVersion: number;
  readonly iv: Uint8Array;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function checkKek(kek: Uint8Array): void {
  if (kek.length !== KEK_BYTES) {
    throw new EnvelopeFormatError(
      `KEK must be ${KEK_BYTES} bytes for AES-256-GCM, got ${kek.length}`,
    );
  }
}

function encodeHeader(header: EnvelopeHeader): Uint8Array {
  const out = new Uint8Array(HEADER_FIXED + header.iv.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = header.format;
  new DataView(out.buffer).setUint32(
    MAGIC.length + 1,
    header.kekVersion,
    false,
  );
  out[MAGIC.length + 5] = header.iv.length;
  out.set(header.iv, HEADER_FIXED);
  return out;
}

function decodeHeader(blob: Uint8Array): {
  header: EnvelopeHeader;
  headerBytes: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
} {
  if (blob.length < HEADER_FIXED) {
    throw new EnvelopeFormatError("blob shorter than the envelope header");
  }
  if (!bytesEqual(blob.subarray(0, MAGIC.length), MAGIC)) {
    throw new EnvelopeFormatError("not an ENVC envelope");
  }
  const format = blob[MAGIC.length]!;
  if (format !== FORMAT_AES_256_GCM) {
    throw new EnvelopeFormatError(`unknown envelope format ${format}`);
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const kekVersion = view.getUint32(MAGIC.length + 1, false);
  const ivLen = blob[MAGIC.length + 5]!;
  const headerLength = HEADER_FIXED + ivLen;
  if (blob.length < headerLength + TAG_BYTES) {
    throw new EnvelopeFormatError("blob too short for its declared iv and tag");
  }
  return {
    header: {
      format,
      kekVersion,
      iv: blob.subarray(HEADER_FIXED, headerLength),
    },
    headerBytes: blob.subarray(0, headerLength),
    // The tag trails the ciphertext, as Web Crypto lays it out; node:crypto
    // keeps the two apart, so the split happens here and nowhere else.
    ciphertext: blob.subarray(headerLength, blob.length - TAG_BYTES),
    tag: blob.subarray(blob.length - TAG_BYTES),
  };
}

/**
 * Context is what the blob is bound to — the row it belongs to, or the freshness
 * of the catalog it was derived from. Moving an authentic blob elsewhere then
 * fails to decrypt instead of resurrecting a value.
 */
export interface SealInput {
  readonly kek: Uint8Array;
  readonly kekVersion: number;
  readonly plaintext: Uint8Array;
  readonly context: Uint8Array;
  /** Injectable for tests; production leaves it to the runtime CSPRNG. */
  readonly iv?: Uint8Array;
}

export function seal(input: SealInput): Uint8Array {
  checkKek(input.kek);
  const iv = input.iv ?? new Uint8Array(randomBytes(IV_BYTES));
  if (iv.length === 0 || iv.length > 255) {
    throw new EnvelopeFormatError(`iv length ${iv.length} is not encodable`);
  }
  const headerBytes = encodeHeader({
    format: FORMAT_AES_256_GCM,
    kekVersion: input.kekVersion,
    iv,
  });
  const cipher = createCipheriv("aes-256-gcm", input.kek, iv);
  cipher.setAAD(concat([headerBytes, input.context]));
  const body = new Uint8Array(
    Buffer.concat([cipher.update(input.plaintext), cipher.final()]),
  );
  return concat([headerBytes, body, new Uint8Array(cipher.getAuthTag())]);
}

export interface OpenInput {
  readonly kek: Uint8Array;
  readonly blob: Uint8Array;
  readonly context: Uint8Array;
}

export function open(input: OpenInput): Uint8Array {
  checkKek(input.kek);
  const { header, headerBytes, ciphertext, tag } = decodeHeader(input.blob);
  try {
    const decipher = createDecipheriv("aes-256-gcm", input.kek, header.iv);
    decipher.setAAD(concat([headerBytes, input.context]));
    decipher.setAuthTag(tag);
    return new Uint8Array(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]),
    );
  } catch {
    // One undifferentiated failure; saying which of wrong key, wrong context or
    // tampering it was would be a guess.
    throw new EnvelopeAuthError(
      "envelope did not authenticate: wrong key, wrong context, or altered bytes",
    );
  }
}

/** Read the header without the key, so a reader can tell which KEK is needed. */
export function readHeader(blob: Uint8Array): EnvelopeHeader {
  return decodeHeader(blob).header;
}

/**
 * Key names are stored as deterministic HMACs, so opening the database without
 * the key shows neither values nor which keys exist. Derived under its own
 * label rather than using the KEK directly for a second algorithm.
 */
export function hashKeyName(kek: Uint8Array, name: string): Uint8Array {
  checkKek(kek);
  const ns = createHmac("sha256", kek).update("envs:key-name:v1").digest();
  return new Uint8Array(createHmac("sha256", ns).update(name, "utf8").digest());
}
