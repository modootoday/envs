import { describe, expect, it } from "vitest";

import {
  EnvelopeAuthError,
  EnvelopeFormatError,
  FORMAT_AES_256_GCM,
  MAGIC,
  hashKeyName,
  open,
  readHeader,
  seal,
} from "../src/crypto/envelope.js";

const KEK = new Uint8Array(32).fill(7);
const OTHER_KEK = new Uint8Array(32).fill(9);
const IV = new Uint8Array(12).fill(3);

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const str = (raw: Uint8Array): string => new TextDecoder().decode(raw);

const rowContext = (
  source: string,
  key: string,
  revision: string,
): Uint8Array => bytes(`${source}|${key}|${revision}`);

const HERE = rowContext("src1", "API_KEY", "rev1");

function sealed(plaintext = "s3cr3t-value", context = HERE, kekVersion = 1) {
  return seal({
    kek: KEK,
    kekVersion,
    plaintext: bytes(plaintext),
    context,
    iv: IV,
  });
}

describe("round trip", () => {
  it("returns the plaintext with the same key and context", () => {
    expect(str(open({ kek: KEK, blob: sealed(), context: HERE }))).toBe(
      "s3cr3t-value",
    );
  });

  it("carries an empty plaintext without becoming empty itself", () => {
    const blob = seal({
      kek: KEK,
      kekVersion: 1,
      plaintext: new Uint8Array(0),
      context: HERE,
    });
    expect(blob.length).toBeGreaterThan(16);
    expect(str(open({ kek: KEK, blob, context: HERE }))).toBe("");
  });

  it("carries bytes that are not text", () => {
    const raw = new Uint8Array([0, 1, 254, 255, 0]);
    const blob = seal({
      kek: KEK,
      kekVersion: 1,
      plaintext: raw,
      context: HERE,
    });
    expect([...open({ kek: KEK, blob, context: HERE })]).toEqual([...raw]);
  });

  it("does not leave the plaintext visible in the blob", () => {
    expect(str(sealed("findme-in-the-bytes")).includes("findme")).toBe(false);
  });
});

describe("the context binds the blob to its position", () => {
  it("refuses a blob replayed onto another key", () => {
    expect(() =>
      open({
        kek: KEK,
        blob: sealed(),
        context: rowContext("src1", "OTHER_KEY", "rev1"),
      }),
    ).toThrow(EnvelopeAuthError);
  });

  it("refuses a blob replayed onto another source", () => {
    expect(() =>
      open({
        kek: KEK,
        blob: sealed(),
        context: rowContext("src2", "API_KEY", "rev1"),
      }),
    ).toThrow(EnvelopeAuthError);
  });

  it("refuses an older revision put back in place", () => {
    expect(() =>
      open({
        kek: KEK,
        blob: sealed(),
        context: rowContext("src1", "API_KEY", "rev2"),
      }),
    ).toThrow(EnvelopeAuthError);
  });
});

describe("key and integrity", () => {
  it("refuses another key", () => {
    expect(() =>
      open({ kek: OTHER_KEK, blob: sealed(), context: HERE }),
    ).toThrow(EnvelopeAuthError);
  });

  it("refuses a single altered ciphertext byte", () => {
    const tampered = Uint8Array.from(sealed());
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => open({ kek: KEK, blob: tampered, context: HERE })).toThrow(
      EnvelopeAuthError,
    );
  });

  it("refuses an altered header, because the header is authenticated", () => {
    const tampered = Uint8Array.from(sealed());
    tampered[MAGIC.length + 4] ^= 0x01; // last byte of kekVersion
    expect(() => open({ kek: KEK, blob: tampered, context: HERE })).toThrow(
      EnvelopeAuthError,
    );
  });

  it("refuses a KEK that is not 32 bytes, on both sides", () => {
    expect(() =>
      seal({
        kek: new Uint8Array(16),
        kekVersion: 1,
        plaintext: bytes("x"),
        context: HERE,
      }),
    ).toThrow(EnvelopeFormatError);
    expect(() =>
      open({ kek: new Uint8Array(16), blob: sealed(), context: HERE }),
    ).toThrow(EnvelopeFormatError);
  });
});

describe("header", () => {
  it("reports the format and KEK version without the key", () => {
    const header = readHeader(sealed("v", HERE, 42));
    expect(header.format).toBe(FORMAT_AES_256_GCM);
    expect(header.kekVersion).toBe(42);
    expect([...header.iv]).toEqual([...IV]);
  });

  it("rejects bytes that are not an envelope", () => {
    expect(() => readHeader(bytes("NOPE and then some padding"))).toThrow(
      /not an ENVC envelope/,
    );
  });

  it("rejects an unknown format rather than guessing", () => {
    const future = Uint8Array.from(sealed());
    future[MAGIC.length] = 99;
    expect(() => readHeader(future)).toThrow(/unknown envelope format/);
  });

  it("rejects a blob too short to hold its declared iv and tag", () => {
    const stub = new Uint8Array(MAGIC.length + 6 + 12);
    stub.set(MAGIC, 0);
    stub[MAGIC.length] = FORMAT_AES_256_GCM;
    stub[MAGIC.length + 5] = 12;
    expect(() => readHeader(stub)).toThrow(/too short/);
  });
});

describe("determinism", () => {
  it("is byte-identical when the iv is fixed, so the iv is the only variable", () => {
    expect([...sealed()]).toEqual([...sealed()]);
  });

  it("differs when the iv is left to the runtime", () => {
    const one = seal({
      kek: KEK,
      kekVersion: 1,
      plaintext: bytes("same"),
      context: HERE,
    });
    const two = seal({
      kek: KEK,
      kekVersion: 1,
      plaintext: bytes("same"),
      context: HERE,
    });
    expect([...one]).not.toEqual([...two]);
  });
});

describe("key names are hashed, not stored", () => {
  it("gives the same hash for the same name and key", () => {
    expect([...hashKeyName(KEK, "API_KEY")]).toEqual([
      ...hashKeyName(KEK, "API_KEY"),
    ]);
  });

  it("gives a different hash under a different key", () => {
    expect([...hashKeyName(KEK, "API_KEY")]).not.toEqual([
      ...hashKeyName(OTHER_KEK, "API_KEY"),
    ]);
  });

  it("does not leave the name recoverable from the hash", () => {
    expect(str(hashKeyName(KEK, "API_KEY")).includes("API")).toBe(false);
  });

  it("separates names that share a prefix", () => {
    expect([...hashKeyName(KEK, "API")]).not.toEqual([
      ...hashKeyName(KEK, "API_KEY"),
    ]);
  });
});
