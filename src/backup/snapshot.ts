/**
 * A snapshot is the catalog file sealed under its own data key, with the key's
 * wraps carried beside it. The wraps are already sealed blobs, so the header
 * gives nothing away — and without them a backup could only be opened by the
 * catalog it came from, which is the thing that may be gone.
 */

import { createHash } from "node:crypto";

import { open, seal } from "../crypto/envelope.js";
import { unlockDek, type DekWrap, type Unlock } from "../crypto/keyring.js";
import { BackupError } from "./provider.js";

export const SNAPSHOT_MAGIC = "ENVSNAP1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface WireWrap {
  readonly wrapId: string;
  readonly method: string;
  readonly salt: string;
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly envelope: string;
}

export interface SnapshotHeader {
  readonly magic: string;
  readonly catalogId: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly sha256: string;
  readonly wraps: readonly WireWrap[];
}

const b64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64");
const unb64 = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, "base64"));

/** Binds the sealed bytes to the catalog they came from. */
function snapshotContext(catalogId: string, createdAt: string): Uint8Array {
  return encoder.encode(`envs:snapshot:v1:${catalogId}:${createdAt}`);
}

export interface PackInput {
  readonly catalogBytes: Uint8Array;
  readonly catalogId: string;
  readonly schemaVersion: number;
  readonly wraps: readonly DekWrap[];
  readonly dek: Uint8Array;
  readonly createdAt: string;
}

export function pack(input: PackInput): Uint8Array {
  const header: SnapshotHeader = {
    magic: SNAPSHOT_MAGIC,
    catalogId: input.catalogId,
    schemaVersion: input.schemaVersion,
    createdAt: input.createdAt,
    // Of the plaintext, so a restore can say the bytes are the ones sealed.
    sha256: createHash("sha256").update(input.catalogBytes).digest("hex"),
    wraps: input.wraps.map((wrap) => ({
      wrapId: wrap.wrapId,
      method: wrap.method,
      salt: b64(wrap.salt),
      n: wrap.n,
      r: wrap.r,
      p: wrap.p,
      envelope: b64(wrap.envelope),
    })),
  };
  const headerBytes = encoder.encode(`${JSON.stringify(header)}\n`);
  const body = seal({
    kek: input.dek,
    kekVersion: 1,
    plaintext: input.catalogBytes,
    context: snapshotContext(input.catalogId, input.createdAt),
  });
  const out = new Uint8Array(headerBytes.length + body.length);
  out.set(headerBytes, 0);
  out.set(body, headerBytes.length);
  return out;
}

export function readHeader(blob: Uint8Array): {
  header: SnapshotHeader;
  body: Uint8Array;
} {
  const newline = blob.indexOf(0x0a);
  if (newline === -1) throw new BackupError("not a snapshot: no header");
  let header: SnapshotHeader;
  try {
    header = JSON.parse(decoder.decode(blob.subarray(0, newline)));
  } catch {
    throw new BackupError("not a snapshot: the header is not JSON");
  }
  if (header.magic !== SNAPSHOT_MAGIC) {
    throw new BackupError(`not a snapshot: magic is ${String(header.magic)}`);
  }
  return { header, body: blob.subarray(newline + 1) };
}

export interface Unpacked {
  readonly header: SnapshotHeader;
  readonly catalogBytes: Uint8Array;
}

export function unpack(blob: Uint8Array, unlock: Unlock): Unpacked {
  const { header, body } = readHeader(blob);
  const wraps: DekWrap[] = header.wraps.map((wrap) => ({
    wrapId: wrap.wrapId,
    method: wrap.method === "kek" ? "kek" : "recovery",
    salt: unb64(wrap.salt),
    n: wrap.n,
    r: wrap.r,
    p: wrap.p,
    envelope: unb64(wrap.envelope),
  }));
  const dek = unlockDek(wraps, unlock);
  const catalogBytes = open({
    kek: dek,
    blob: body,
    context: snapshotContext(header.catalogId, header.createdAt),
  });
  const digest = createHash("sha256").update(catalogBytes).digest("hex");
  if (digest !== header.sha256) {
    // The envelope already authenticates; this catches a header that was
    // rewritten to describe different bytes.
    throw new BackupError("snapshot contents do not match the header digest");
  }
  return { header, catalogBytes };
}

/** Sorts newest last, which is the order a listing should read in. */
export function snapshotName(catalogId: string, createdAt: string): string {
  const stamp = createdAt.replace(/[:.]/g, "-");
  return `${catalogId.slice(0, 8)}-${stamp}.envsnap`;
}
