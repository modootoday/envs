import { describe, expect, it } from "vitest";

import {
  MIGRATIONS,
  SCHEMA_VERSION,
  createSchema,
} from "../src/catalog/schema.js";
import { writeWraps } from "../src/catalog/write.js";
import { readWraps } from "../src/loader/read.js";
import {
  createKeyring,
  kdfFor,
  sameKey,
  unlockDek,
} from "../src/crypto/keyring.js";
import { openDatabaseSync, type Database } from "../src/sqlite/open.js";

const KEK = new Uint8Array(32).fill(3);
const DEK = new Uint8Array(32).fill(9);

async function catalog(): Promise<Database> {
  const db = openDatabaseSync(":memory:");
  createSchema(db);
  return db;
}

describe("which KDF a wrap gets", () => {
  it("stretches a recovery code and does not stretch a key", () => {
    expect(kdfFor("recovery")).toBe("scrypt");
    expect(kdfFor("kek")).toBe("hkdf");
  });

  it("does not put the choice on the wrap, because it is derivable", () => {
    const ring = createKeyring({ kek: KEK, recoveryCodes: 1, dek: DEK });
    for (const wrap of ring.wraps) {
      expect(Object.keys(wrap)).not.toContain("kdf");
    }
  });

  it("costs a key unlock almost nothing, which was the point", () => {
    const ring = createKeyring({ kek: KEK, recoveryCodes: 1, dek: DEK });
    const started = process.hrtime.bigint();
    unlockDek(ring.wraps, { kek: KEK });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // scrypt at N=2^15 took over 100 ms here; this asserts the ceiling rather
    // than a number, so a slower machine does not fail it.
    expect(ms).toBeLessThan(20);
  });

  it("still stretches a recovery code, so guessing stays expensive", () => {
    const ring = createKeyring({ kek: KEK, recoveryCodes: 1, dek: DEK });
    const started = process.hrtime.bigint();
    unlockDek(ring.wraps, { recoveryCode: ring.recoveryCodes[0]! });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeGreaterThan(10);
  });
});

describe("the KDF is derived, not carried", () => {
  it("survives a write and a read that know nothing about it", async () => {
    const db = await catalog();
    const ring = createKeyring({ kek: KEK, recoveryCodes: 1, dek: DEK });
    writeWraps(db, ring.wraps);

    // Nothing in the row says which KDF made the wrap, and it still opens:
    // a field that is a pure function of another cannot be lost in transit.
    const columns = db
      .prepare<{ name: string }>("PRAGMA table_info(dek_wraps)")
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain("kdf");

    const back = readWraps(db);
    expect(sameKey(unlockDek(back, { kek: KEK }), DEK)).toBe(true);
    expect(
      sameKey(unlockDek(back, { recoveryCode: ring.recoveryCodes[0]! }), DEK),
    ).toBe(true);
    db.close();
  });

  it("gives the two methods different derivations", () => {
    const ring = createKeyring({ kek: KEK, recoveryCodes: 1, dek: DEK });
    const kek = ring.wraps.find((w) => w.method === "kek")!;
    // Reading a key wrap as if it were a code wrap derives another key.
    expect(() =>
      unlockDek([{ ...kek, method: "recovery" }], {
        recoveryCode: ring.recoveryCodes[0]!,
      }),
    ).toThrow();
  });
});

describe("the migration ladder", () => {
  it("has one entry per version up to the current one", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(
      Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1),
    );
  });
});
