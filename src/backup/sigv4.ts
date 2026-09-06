/**
 * AWS Signature Version 4, for S3 and everything that speaks it — R2, MinIO,
 * Backblaze. Written here because the package ships no runtime dependencies,
 * and because the signing steps are short and fully specified.
 */

import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";

export interface SignInput {
  readonly method: string;
  /** Already URI-encoded, beginning with a slash. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  /** Injectable so a signature can be compared against a known one. */
  readonly now?: Date;
}

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: Uint8Array | string, data: string): Uint8Array =>
  new Uint8Array(createHmac("sha256", key).update(data, "utf8").digest());

/** Basic-format timestamp: 20260906T101530Z. */
export function amzDate(now: Date): string {
  return `${now.toISOString().replace(/[:-]|\.\d{3}/g, "")}`;
}

/** Each segment percent-encoded, with the slashes left alone. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function canonicalQuery(query: Readonly<Record<string, string>>): string {
  return Object.keys(query)
    .sort()
    .map(
      (key) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(query[key] ?? "")}`,
    )
    .join("&");
}

export interface Signed {
  readonly headers: Record<string, string>;
  /** Exposed so a test can compare the intermediate steps, not just the result. */
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

export function signRequest(input: SignInput): Signed {
  const now = input.now ?? new Date();
  const stamp = amzDate(now);
  const day = stamp.slice(0, 8);
  const payloadHash = sha256Hex(input.body);

  const headers: Record<string, string> = {
    ...input.headers,
    "x-amz-date": stamp,
    "x-amz-content-sha256": payloadHash,
  };
  if (input.sessionToken !== undefined && input.sessionToken !== "") {
    headers["x-amz-security-token"] = input.sessionToken;
  }

  // Header names lower-cased and sorted, values trimmed: the canonical request
  // is a byte-for-byte contract, and a stray space changes the signature.
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lookup = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const canonicalHeaders = names
    .map((name) => `${name}:${(lookup.get(name) ?? "").trim()}\n`)
    .join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    canonicalQuery(input.query ?? {}),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    stamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${input.secretAccessKey}`, day);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = Buffer.from(hmac(kSigning, stringToSign)).toString("hex");

  return {
    headers: {
      ...headers,
      authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}
