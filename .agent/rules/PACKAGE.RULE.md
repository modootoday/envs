# envs — registry rules

> Package: `@modootoday/envs`
> Scope: the template registry under `registry/`, its published copies under
> `docs/`, and the guards in `__tests__/registry*.test.ts`

A template says what a provider's credentials are called, which of them may be
published, and where to get them. Everything below exists because getting the
second of those wrong is the one mistake this registry can make that a reader
cannot undo.

## Sensitivity is a permission, not a label

`config` stores at level low, and `envs build` bakes low keys into a browser
bundle without asking. So marking a key `config` is this registry telling a
stranger that shipping it to a browser is fine.

- **Silence resolves to `secret`.** A provider that says nothing has not said
  yes. A key wrongly kept private costs a build step; one wrongly published
  cannot be recalled.
- **Two grounds admit a `config`, and the template must say which.** Either the
  provider states the key is public, quoted in the description, or the
  provider's own integration requires the value in the browser, in which case
  say that is the basis rather than implying a quote exists.
- **Half of an authenticating pair stays `secret`.** An AWS access key id, a
  Twilio account SID, a Cloudflare account email, a Docker Hub username and a
  Jira email address all authenticate. An identifier that authenticates nothing
  on its own, such as an organisation id, does not.
- **A composite is as sensitive as the worst thing inside it.** `CLOUDINARY_URL`
  holds a cloud name, a key and a secret; two of the three are ones Cloudinary
  says there is no problem exposing, and the joined value is still secret.
- **One value used on both sides is exposed for both.** Where a provider's
  sample puts the same server token in the browser, the browser spelling is not
  offered.

`__tests__/registry-sensitivity.test.ts` holds the whole `config` set by name,
so adding one is a decision somebody made and a slip is a failing test. A blunt
name check refuses anything called a secret, token, password or access key;
where a provider calls a genuinely public credential a token, add a named
exception with the provider's sentence rather than loosening the rule.

## Patterns only where the provider commits to one

A pattern that refuses a valid key is worse than no pattern.

- A prefix seen only in examples is not a documented shape.
- Where two forms are both current, declare neither: Paddle's keys carry a
  `pdl_` prefix only if issued after May 2025, and older ones still work.
- Claim no more than the documentation states. Replicate documents forty
  characters beginning `r8_` but not the character set, so the pattern checks
  the prefix and the length and nothing else.
- Asana and Airtable ask not to be pattern matched, saying tokens are opaque
  and the format may change. Take them at their word.

## Names carry their provenance

Say "the name is convention" when the provider documents the credential but not
a variable for it. A reader who cannot tell a documented name from a popular one
will assume the wrong one is load-bearing.

Do not offer a variable for a value the provider never reads from the
environment: New Relic's browser key is pasted into a page snippet, so a
variable for it would describe a workflow that does not exist.

## Growth is data, not code

Namespaces, their obtain allowlists and the reserved list live in
`registry/namespaces.json` and are published to `docs/v1/namespaces.json`. A
provider arriving must not need a new release of the CLI. Key name syntax and
schema limits stay in code, because they are grammar rather than policy.

## Guards must be able to fail

Test the registry against something other than the code that reads it. The
reachability check enumerates templates with Node's own recursive listing
rather than the walk at the top of the same file, so a bug in that walk cannot
agree with itself.
