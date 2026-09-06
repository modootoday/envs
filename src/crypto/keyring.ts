/**
 * Key hierarchy. Values are sealed under a random DEK, and the DEK is wrapped
 * once per way of getting it back: the KEK, and each recovery code. Losing one
 * way costs nothing as long as another wrap survives.
 */

import {
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

import { EnvelopeAuthError, open, seal } from "./envelope.js";

export const DEK_BYTES = 32;
const SALT_BYTES = 16;
const CODE_BITS = 130; // 26 Crockford characters, five groups of five plus one

/** Crockford base32: no I, L, O or U, so a transcribed code cannot be misread. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUP = 5;

export type WrapMethod = "kek" | "recovery";

export type Kdf = "scrypt" | "hkdf";

export interface DekWrap {
  readonly wrapId: string;
  readonly method: WrapMethod;
  readonly salt: Uint8Array;
  /** scrypt cost, stored so a future default cannot orphan an old wrap. */
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly envelope: Uint8Array;
}

/**
 * Stretching slows down guessing. A recovery code is short enough to guess
 * offline, so it gets scrypt; a 32-byte random key is not, so it gets HKDF and
 * costs microseconds. Paying scrypt for the key was 94% of what a consuming
 * process spent at start and bought nothing.
 *
 * Derived from the method rather than stored: a column would be one more thing
 * to carry through a write, a read and a snapshot, and dropping it anywhere
 * yields a wrap that derives the wrong key and simply will not open.
 */
export function kdfFor(method: WrapMethod): Kdf {
  return method === "recovery" ? "scrypt" : "hkdf";
}

export interface Keyring {
  readonly dek: Uint8Array;
  readonly wraps: readonly DekWrap[];
  /** Shown once at creation. Never stored, never recoverable from the wraps. */
  readonly recoveryCodes: readonly string[];
}

export class RecoveryCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryCodeError";
  }
}

export class KeyringLockedError extends Error {
  constructor(readonly tried: number) {
    super(
      `none of the ${tried} wraps opened with the secret given; try another recovery code or the KEK`,
    );
    this.name = "KeyringLockedError";
  }
}

/**
 * Deliberately expensive, because a recovery code is offline-guessable in a way
 * a 32-byte KEK is not. Unwrapping happens once per process at most.
 */
export const SCRYPT = Object.freeze({ n: 1 << 15, r: 8, p: 1 });

export function formatRecoveryCode(raw: string): string {
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += GROUP)
    groups.push(raw.slice(i, i + GROUP));
  return groups.join("-");
}

export function generateRecoveryCode(): string {
  const chars = Math.ceil(CODE_BITS / 5);
  const source = randomBytes(chars);
  let out = "";
  for (let i = 0; i < chars; i += 1) {
    // No rejection sampling needed: 32 divides 256 exactly, so a byte modulo
    // the alphabet length is uniform.
    out += ALPHABET[source[i]! % ALPHABET.length];
  }
  return formatRecoveryCode(out);
}

/**
 * Accepts what a person actually types: any case, any separators, and the
 * letters Crockford treats as digits. A code rejected for a typo that the
 * alphabet was designed to absorb is a lost catalog.
 */
export function normaliseRecoveryCode(input: string): string {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (cleaned.length === 0) {
    throw new RecoveryCodeError("recovery code is empty");
  }
  for (const ch of cleaned) {
    if (!ALPHABET.includes(ch)) {
      throw new RecoveryCodeError(
        `recovery code contains "${ch}", which is not in the alphabet`,
      );
    }
  }
  return cleaned;
}

function wrapKeyFrom(
  secret: Uint8Array,
  salt: Uint8Array,
  method: WrapMethod,
  cost: { n: number; r: number; p: number },
): Uint8Array {
  if (kdfFor(method) === "hkdf") {
    return new Uint8Array(
      hkdfSync("sha256", secret, salt, "envs:dek-wrap:v1", DEK_BYTES),
    );
  }
  return new Uint8Array(
    scryptSync(secret, salt, DEK_BYTES, {
      N: cost.n,
      r: cost.r,
      p: cost.p,
      // scrypt's default cap is below what N=32768 needs.
      maxmem: 256 * cost.n * cost.r,
    }),
  );
}

const encoder = new TextEncoder();

/** Binds a wrap to its own id and method, so wraps cannot be swapped. */
function wrapContext(wrapId: string, method: WrapMethod): Uint8Array {
  return encoder.encode(`envs:dek-wrap:v1:${method}:${wrapId}`);
}

function makeWrap(
  dek: Uint8Array,
  secret: Uint8Array,
  method: WrapMethod,
  wrapId: string,
): DekWrap {
  const salt = new Uint8Array(randomBytes(SALT_BYTES));
  const key = wrapKeyFrom(secret, salt, method, SCRYPT);
  return {
    wrapId,
    method,
    salt,
    n: SCRYPT.n,
    r: SCRYPT.r,
    p: SCRYPT.p,
    envelope: seal({
      kek: key,
      kekVersion: 1,
      plaintext: dek,
      context: wrapContext(wrapId, method),
    }),
  };
}

export interface CreateKeyringOptions {
  readonly kek: Uint8Array;
  /** How many recovery codes to mint. Zero means the KEK is the only way back. */
  readonly recoveryCodes?: number;
  /** Injectable so a test can assert on fixed material. */
  readonly dek?: Uint8Array;
  readonly newId?: () => string;
  readonly newCode?: () => string;
}

export function createKeyring(options: CreateKeyringOptions): Keyring {
  const dek = options.dek ?? new Uint8Array(randomBytes(DEK_BYTES));
  const newId = options.newId ?? (() => crypto.randomUUID());
  const newCode = options.newCode ?? generateRecoveryCode;

  const wraps: DekWrap[] = [makeWrap(dek, options.kek, "kek", newId())];
  const codes: string[] = [];
  for (let i = 0; i < (options.recoveryCodes ?? 0); i += 1) {
    const code = newCode();
    codes.push(code);
    wraps.push(
      makeWrap(
        dek,
        encoder.encode(normaliseRecoveryCode(code)),
        "recovery",
        newId(),
      ),
    );
  }
  return { dek, wraps, recoveryCodes: codes };
}

export type Unlock =
  { readonly kek: Uint8Array } | { readonly recoveryCode: string };

/**
 * Tries every wrap of the matching method. A recovery code is checked against
 * all of them because the holder cannot know which wrap is theirs.
 */
export function unlockDek(
  wraps: readonly DekWrap[],
  unlock: Unlock,
): Uint8Array {
  const method: WrapMethod = "kek" in unlock ? "kek" : "recovery";
  const secret =
    "kek" in unlock
      ? unlock.kek
      : encoder.encode(normaliseRecoveryCode(unlock.recoveryCode));

  const candidates = wraps.filter((wrap) => wrap.method === method);
  for (const wrap of candidates) {
    const key = wrapKeyFrom(secret, wrap.salt, wrap.method, wrap);
    try {
      return open({
        kek: key,
        blob: wrap.envelope,
        context: wrapContext(wrap.wrapId, wrap.method),
      });
    } catch (error) {
      if (!(error instanceof EnvelopeAuthError)) throw error;
    }
  }
  throw new KeyringLockedError(candidates.length);
}

/** Same DEK, a new wrap: adds a way back without re-encrypting any value. */
export function addWrap(
  dek: Uint8Array,
  unlock: Unlock,
  wrapId: string,
): DekWrap {
  const method: WrapMethod = "kek" in unlock ? "kek" : "recovery";
  const secret =
    "kek" in unlock
      ? unlock.kek
      : encoder.encode(normaliseRecoveryCode(unlock.recoveryCode));
  return makeWrap(dek, secret, method, wrapId);
}

/** Constant-time comparison, for callers verifying a DEK round trip. */
export function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
