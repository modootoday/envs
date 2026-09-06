import { describe, expect, it } from "vitest";

import {
  addWrap,
  createKeyring,
  DEK_BYTES,
  formatRecoveryCode,
  generateRecoveryCode,
  KeyringLockedError,
  normaliseRecoveryCode,
  RecoveryCodeError,
  sameKey,
  unlockDek,
} from "../src/crypto/keyring.js";

const KEK = new Uint8Array(32).fill(1);
const OTHER_KEK = new Uint8Array(32).fill(2);
const DEK = new Uint8Array(DEK_BYTES).fill(3);

let counter = 0;
const ids = (): string => `wrap-${(counter += 1)}`;

function ring(codes: number, fixedCodes?: readonly string[]) {
  let i = 0;
  return createKeyring({
    kek: KEK,
    recoveryCodes: codes,
    dek: DEK,
    newId: ids,
    ...(fixedCodes ? { newCode: () => fixedCodes[i++]! } : {}),
  });
}

describe("what init produces", () => {
  it("mints one wrap for the KEK and one per recovery code", () => {
    const keyring = ring(3);
    expect(keyring.wraps).toHaveLength(4);
    expect(keyring.wraps.filter((w) => w.method === "kek")).toHaveLength(1);
    expect(keyring.wraps.filter((w) => w.method === "recovery")).toHaveLength(
      3,
    );
    expect(keyring.recoveryCodes).toHaveLength(3);
  });

  it("keeps the codes out of everything that gets stored", () => {
    const keyring = ring(2);
    const stored = JSON.stringify(
      keyring.wraps.map((w) => ({
        ...w,
        salt: [...w.salt],
        envelope: [...w.envelope],
      })),
    );
    for (const code of keyring.recoveryCodes) {
      expect(stored).not.toContain(code);
      expect(stored).not.toContain(normaliseRecoveryCode(code));
    }
  });

  it("mints distinct codes", () => {
    const keyring = ring(8);
    expect(new Set(keyring.recoveryCodes).size).toBe(8);
  });

  it("can be created with no recovery codes at all", () => {
    const keyring = ring(0);
    expect(keyring.recoveryCodes).toEqual([]);
    expect(keyring.wraps).toHaveLength(1);
  });
});

describe("unlocking", () => {
  it("returns the same DEK from the KEK", () => {
    const keyring = ring(2);
    expect(sameKey(unlockDek(keyring.wraps, { kek: KEK }), DEK)).toBe(true);
  });

  it("returns the same DEK from any one of the recovery codes", () => {
    const keyring = ring(3);
    for (const code of keyring.recoveryCodes) {
      expect(
        sameKey(unlockDek(keyring.wraps, { recoveryCode: code }), DEK),
      ).toBe(true);
    }
  });

  it("still opens after the KEK wrap is gone, which is the point", () => {
    const keyring = ring(2);
    const withoutKek = keyring.wraps.filter((w) => w.method !== "kek");
    expect(
      sameKey(
        unlockDek(withoutKek, { recoveryCode: keyring.recoveryCodes[0]! }),
        DEK,
      ),
    ).toBe(true);
  });

  it("refuses another KEK", () => {
    const keyring = ring(1);
    expect(() => unlockDek(keyring.wraps, { kek: OTHER_KEK })).toThrow(
      KeyringLockedError,
    );
  });

  it("refuses a code that was never minted", () => {
    const keyring = ring(1);
    expect(() =>
      unlockDek(keyring.wraps, { recoveryCode: generateRecoveryCode() }),
    ).toThrow(KeyringLockedError);
  });

  it("refuses when there is no wrap of the method asked for", () => {
    const keyring = ring(0);
    expect(() =>
      unlockDek(keyring.wraps, { recoveryCode: generateRecoveryCode() }),
    ).toThrow(/0 wraps/);
  });

  it("does not open a wrap moved onto another wrap's identity", () => {
    const keyring = ring(2);
    const [first, second] = keyring.wraps.filter(
      (w) => w.method === "recovery",
    );
    const swapped = { ...first!, envelope: second!.envelope };
    expect(() =>
      unlockDek([swapped], { recoveryCode: keyring.recoveryCodes[1]! }),
    ).toThrow(KeyringLockedError);
  });
});

describe("what a person can actually type", () => {
  const CODE = "0123456789ABCDEFGHJKMNPQRS";

  it("accepts lower case and any grouping", () => {
    const keyring = ring(1, [formatRecoveryCode(CODE)]);
    for (const typed of [
      CODE.toLowerCase(),
      formatRecoveryCode(CODE),
      formatRecoveryCode(CODE).toLowerCase(),
      `  ${CODE.slice(0, 10)} ${CODE.slice(10)}  `,
    ]) {
      expect(
        sameKey(unlockDek(keyring.wraps, { recoveryCode: typed }), DEK),
      ).toBe(true);
    }
  });

  it("reads the letters Crockford treats as digits", () => {
    expect(normaliseRecoveryCode("ILO")).toBe("110");
    expect(normaliseRecoveryCode("il-o")).toBe("110");
  });

  it("never mints a character that could be misread", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateRecoveryCode()).not.toMatch(/[ILOU]/);
    }
  });

  it("names the offending character rather than failing blankly", () => {
    expect(() => normaliseRecoveryCode("ABC$")).toThrow(RecoveryCodeError);
    expect(() => normaliseRecoveryCode("ABC$")).toThrow(/"\$"/);
  });

  it("refuses an empty code", () => {
    expect(() => normaliseRecoveryCode("  -- ")).toThrow(/empty/);
  });

  it("is long enough to be worth stretching", () => {
    expect(normaliseRecoveryCode(generateRecoveryCode()).length).toBe(26);
  });
});

describe("adding a way back later", () => {
  it("wraps the same DEK under a new code without touching any value", () => {
    const keyring = ring(1);
    const newCode = generateRecoveryCode();
    const added = addWrap(keyring.dek, { recoveryCode: newCode }, "wrap-new");
    expect(sameKey(unlockDek([added], { recoveryCode: newCode }), DEK)).toBe(
      true,
    );
    expect(sameKey(unlockDek(keyring.wraps, { kek: KEK }), DEK)).toBe(true);
  });
});

describe("cost parameters travel with the wrap", () => {
  it("stores what it used, so a later default cannot orphan it", () => {
    const keyring = ring(1);
    for (const wrap of keyring.wraps) {
      expect(wrap.n).toBeGreaterThanOrEqual(1 << 14);
      expect(wrap.r).toBeGreaterThan(0);
      expect(wrap.p).toBeGreaterThan(0);
      expect(wrap.salt.length).toBe(16);
    }
  });
});
