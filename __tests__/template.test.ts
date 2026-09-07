import { describe, expect, it } from "vitest";

import { checkNamespace, checkObtain } from "../src/template/registry.js";
import {
  assertNoDuplicateKeys,
  compilePattern,
  parseTemplate,
  templateDigest,
} from "../src/template/schema.js";

const valid = {
  name: "stripe/backend",
  version: 1,
  title: "Stripe — server-side integration",
  keys: {
    STRIPE_SECRET_KEY: {
      required: true,
      sensitivity: "secret",
      pattern: "^sk_(test|live)_[A-Za-z0-9]{24,}$",
      obtain: "https://dashboard.stripe.com/apikeys",
      rotateDays: 90,
      description: "Server-side API key.",
    },
  },
};

const text = (override: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...valid, ...override });

const parse = (value: string) =>
  parseTemplate(value, {
    allowObtain: (url, at) => {
      checkObtain(JSON.parse(value).name as string, url, at);
    },
  });

describe("a template is a schema for keys and never a place for a value", () => {
  it("accepts the shape the design names", () => {
    const template = parse(text());
    expect(template.name).toBe("stripe/backend");
    expect(template.keys["STRIPE_SECRET_KEY"]?.rotateDays).toBe(90);
  });

  it("refuses a field the schema does not name", () => {
    // The field that matters is any field able to hold a value. A tolerant
    // parser is how one arrives without anybody deciding to add it.
    expect(() => parse(text({ example: "sk_live_realkey" }))).toThrow(
      /unknown field "example"/,
    );
  });

  it("refuses an unnamed field on a key, including example", () => {
    expect(() =>
      parse(
        JSON.stringify({
          ...valid,
          keys: {
            A_KEY: {
              required: true,
              sensitivity: "secret",
              example: "sk_live_realkey",
            },
          },
        }),
      ),
    ).toThrow(/unknown field "example"/);
  });

  it("refuses a duplicate field the parser would silently merge", () => {
    // JSON.parse keeps the last one, so this is unreachable after parsing.
    expect(() => assertNoDuplicateKeys('{"name":"a/b","name":"c/d"}')).toThrow(
      /duplicate field "name"/,
    );
  });

  it("allows the same field name in sibling objects", () => {
    expect(() =>
      assertNoDuplicateKeys(
        '{"keys":{"A":{"required":true},"B":{"required":true}}}',
      ),
    ).not.toThrow();
  });

  it("requires a two-part lowercase name", () => {
    expect(() => parse(text({ name: "Stripe/Backend" }))).toThrow(/name must/);
    expect(() => parse(text({ name: "backend" }))).toThrow(/name must/);
  });

  it("requires at least one key", () => {
    expect(() => parse(text({ keys: {} }))).toThrow(/at least one key/);
  });

  it("refuses a key name that does not start upper case", () => {
    const names = [
      "lower-case",
      "lowerCase",
      "_LEADING",
      "9LIVES",
      "HAS SPACE",
    ];
    const refused = names.filter((name) => {
      try {
        parse(
          text({ keys: { [name]: { required: true, sensitivity: "config" } } }),
        );
        return false;
      } catch (error) {
        return /upper case/.test(String(error));
      }
    });
    expect(refused).toEqual(names);
  });

  it("admits a provider name that carries a lower case hostname", () => {
    // HCP Terraform reads TF_TOKEN_ plus the host, periods as underscores.
    const parsed = parse(
      text({
        keys: {
          TF_TOKEN_app_terraform_io: {
            required: true,
            sensitivity: "secret",
          },
        },
      }),
    );
    expect(Object.keys(parsed.keys)).toEqual(["TF_TOKEN_app_terraform_io"]);
  });

  it("requires a declared sensitivity", () => {
    expect(() =>
      parse(
        text({ keys: { A_KEY: { required: true, sensitivity: "maybe" } } }),
      ),
    ).toThrow(/sensitivity/);
  });
});

describe("a pattern is compiled where it is declared, not where it is used", () => {
  it("accepts an anchored pattern", () => {
    expect(compilePattern("^sk_[a-z]{4}$", "at").test("sk_abcd")).toBe(true);
  });

  it("refuses an unanchored pattern", () => {
    // Unanchored, the swapped-key check passes on the swapped key, which is
    // the one accident the pattern exists to catch.
    expect(() => compilePattern("sk_[a-z]+", "at")).toThrow(/anchored/);
  });

  it.each(["^(a+)+$", "^(a*)*$", "^([a-z]+)*$", "^([a-z]+){2,}$"])(
    "refuses %s rather than timing it",
    (pattern) => {
      expect(() => compilePattern(pattern, "at")).toThrow(/may not halt/);
    },
  );

  it("does not mistake an ordinary alternation for one", () => {
    // The real Stripe pattern. A detector that flags this rejects every
    // useful template, which is the failure that gets the check deleted.
    expect(() =>
      compilePattern("^sk_(test|live)_[A-Za-z0-9]{24,}$", "at"),
    ).not.toThrow();
  });

  it("refuses a pattern that does not compile", () => {
    expect(() => compilePattern("^([a-z]$", "at")).toThrow(/valid regular/);
  });

  it("refuses a pattern longer than the bound", () => {
    expect(() => compilePattern(`^${"a".repeat(220)}$`, "at")).toThrow(
      /longer than/,
    );
  });
});

describe("an obtain link may only point at its own provider", () => {
  it("accepts the provider's own domain", () => {
    expect(() =>
      checkObtain(
        "stripe/backend",
        "https://dashboard.stripe.com/apikeys",
        "at",
      ),
    ).not.toThrow();
  });

  it("refuses another host under a reserved name", () => {
    // Without this the marketplace distributes the phishing page, from our
    // domain, under the provider's name.
    expect(() =>
      checkObtain("stripe/backend", "https://stripe.evil.test/apikeys", "at"),
    ).toThrow(/not one of/);
  });

  it("refuses http", () => {
    expect(() =>
      checkObtain("stripe/backend", "http://dashboard.stripe.com/x", "at"),
    ).toThrow(/https/);
  });

  it("refuses credentials in the URL", () => {
    expect(() =>
      checkObtain("stripe/backend", "https://u:p@dashboard.stripe.com/x", "at"),
    ).toThrow(/credentials/);
  });

  it("refuses linking out from a namespace with no allowlist", () => {
    expect(() =>
      checkObtain("someone/thing", "https://example.test/keys", "at"),
    ).toThrow(/no obtain allowlist/);
  });
});

describe("reserved namespaces are held rather than first-come", () => {
  it("refuses a stranger publishing under a provider name", () => {
    expect(() => checkNamespace("stripe/backend", "someone")).toThrow(
      /reserved namespace/,
    );
  });

  it("admits our own publication", () => {
    expect(() => checkNamespace("stripe/backend", "modootoday")).not.toThrow();
  });

  it("leaves unreserved namespaces open", () => {
    expect(() => checkNamespace("someone/thing", "someone")).not.toThrow();
  });
});

describe("a catalog can tell that a template changed under it", () => {
  it("digests the published bytes", async () => {
    // Independently: printf '{}' | sha256sum
    expect(await templateDigest("{}")).toBe(
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
  });

  it("gives different bytes different digests", async () => {
    expect(await templateDigest(text())).not.toBe(
      await templateDigest(text({ version: 2 })),
    );
  });
});
