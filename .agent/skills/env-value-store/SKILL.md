---
name: env-value-store
description: Use when environment values are spread across several .env files, layers or machines and something reads the wrong one — a key defined twice with different values, a config file loaded as if it were env, a value that works locally and is missing in CI, or a secret that needs rotating in more than one place. Covers @modootoday/envs, which keeps the values in an encrypted catalog and answers where each one came from.
---

# Using `@modootoday/envs`

## Implementation status

This package is under construction. Only what this section lists exists today; the
rest of this document describes the designed surface and is not yet callable.

- Implemented: the format parser, the sqlite adapter over three backends, the AES-GCM
  envelope, the keyring with recovery codes, the catalog schema and its version gate,
  `config()` resolving both layers, and every command the design named.
- Nothing is left planned. An unknown verb says "unknown command".

### build is the dangerous one

It bakes values into a module for targets that cannot read a file. Default is **nothing
selected**, and a key not classified `low` is refused even when named — unclassified
reads as `medium`, so saying nothing gives the safe answer. `--allow-sensitive` exists
and should be argued for, not reached for: a deployed bundle cannot be recalled.

### serve hands over bytes, not values

It serves the sealed catalog. It holds no key and cannot decrypt, so a compromised server
gives up what a stolen catalog file would and no more. Requiring a token of real length
is the whole security of the endpoint, so it is required rather than generated quietly,
and binding to anything but localhost warns that the token crosses the wire.

`--once` stops after the catalog is **handed over**, not after any request: an
unauthorised probe must not end a one-shot pull before the client with the token arrives.

### Backups follow the same provider rule as the sqlite backends

Differences are data, eligibility is declared rather than discovered by failing, and a
pin exercises the non-default path. `s3` covers S3, R2, MinIO and Backblaze — what
differs between them is a hostname — and `file` writes to a directory. Neither is
eligible unless configured: a destination nobody set is a missing setting, not a failed
write.

A snapshot seals the catalog under its data key and carries that key's **wraps in the
header**. Without them a backup could only be opened by the catalog it came from, which
is the thing that may be gone — so **a recovery code alone restores**, which is the whole
point. The wraps are already sealed blobs, so the header leaks nothing.

SigV4 is implemented here rather than depended on, and verified against the derivation
vector AWS publishes. **No live endpoint was exercised**; say so rather than implying the
S3 path has been run against a real bucket.

- **Restore must delete the `-wal` and `-shm` beside the catalog.** Replacing only the
  main file leaves the old journal, and sqlite replays it onto the restored database —
  the values the snapshot was taken to undo come straight back. Measured on bun, where
  the write had not been checkpointed; node passed by luck. It pairs with the
  `wal_checkpoint(TRUNCATE)` backup takes before reading the file.

### The surface deliberately matches dotenvx

dotenvx, Doppler and Infisical have converged on the same shape, so this package uses it
rather than inventing names: `run -- <cmd>` to inject, `get`/`set`/`del` for values,
`ls` to list, `export --format` to take them out, plus `rotate`, `genexample`,
`gitignore` and `precommit`. `set` accepts both `KEY VALUE` and `KEY=VALUE` because the
three tools disagree about which one is canonical — but refuses them mixed, since
`set A=1 B=2` could be read either way.

Three deliberate differences, worth stating when a user expects dotenvx exactly:

- **No `encrypt`/`decrypt`.** dotenvx encrypts a file in place; this keeps a store, and
  the round trip is `load` then `export`.
- **`get` with no key does not print everything.** dotenvx does, but that would make the
  `export --yes` gate meaningless. Names come from `ls --keys`, values from `export`.
- **No `native`, `armor` or `lock`** — those are that service's own features.

`rotate` is cheap here because of the key hierarchy: it re-wraps the data key and
re-encrypts nothing. New wraps are written **before** the old ones are retired, so an
interruption leaves too many ways in rather than none.

### The shape of a change

Releases are immutable. `load` and `set` both write a **new** release carrying every
value with the change applied, and move the pointer; `rollback` moves the pointer back.
Nothing is deleted, which is what makes going back cheap and reversible. Two consequences
worth telling a user: `load` carries other sources forward unless `--replace`, so loading
one file does not empty the rest; and `set` refuses to guess which source owns a key when
there is more than one.

`doctor` answers where a value came from. Same key with the same value in two sources
warns, different values error, and neither prints a value. It also names the catalogs it
actually read — running in the wrong directory is the one trap this layout has.

### Losing a key does not lose the catalog

Values are sealed under a random DEK, and the DEK is wrapped once per way back: the KEK,
and each recovery code. Any one wrap opens it, so a lost KEK costs nothing while a
recovery code survives, and a new way back can be added without re-encrypting a value.

**Recovery codes are printed once at `init` and never stored** — the table holds only the
wrapped DEK, so it cannot give a code back. Codes are Crockford base32 (no I, L, O or U)
and are accepted in any case with any separators, because refusing a transcription slip
the alphabet was designed to absorb would mean a lost catalog.

To open a catalog with one:

```
printf '%s' "$CODE" | npx @modootoday/envs export --yes --recovery-code -
```

`export` is the only command that prints values, so it refuses without `--yes`, prefers
stdin over argv for the code, and warns when a code is passed inline where other
processes can see it. Its CSV quotes every field — env values really do contain commas,
quotes and newlines — and a value starting with `=`, `+`, `-` or `@` is **reported, not
rewritten**: altering it would hand back something the catalog does not hold.

### Working on this package

The suite must pass under **both** runtimes, and running only one hides real defects.
`npx vitest run` uses node; `bunx --bun vitest run` uses bun.

Three sqlite backends sit behind one interface, and everything they disagree about is
data in `src/sqlite/provider.ts`. Do not reintroduce these differences in calling code:

- **Booleans.** node and better-sqlite3 throw on a bound boolean, bun accepts it. Bind
  through the adapter, which normalises to 0/1.
- **A missing row.** bun returns `null` from `get()` and node returns `undefined`, so a
  `!== undefined` check passes on one and dereferences null on the other. The adapter
  returns `undefined` on both; do not compare against `null` in calling code.
- **Named parameters.** bun needs the sigil form (`$a`), better-sqlite3 needs the bare
  name (`a`), node takes either. Getting it wrong is **not always an error**: bun binds
  NULL and says nothing, so the adapter matches keys against the statement's own
  placeholders.
- **Constructor options.** bun rejects `{}` and `{readonly:false}` and wants
  `create: true`; node spells it `readOnly` and **silently ignores** the lowercase
  spelling, handing back a writable database; better-sqlite3 wants the lowercase name.
  Assert that a write is actually refused, never that a flag was passed.
- **Eligibility is checked, not attempted.** Loading better-sqlite3 under bun 1.3.14
  panics the process with `NAPI FATAL ERROR` — no try/catch contains it. A provider
  declares where it may run.
- **Import through a variable specifier.** A literal makes TypeScript try to resolve
  `bun:sqlite` and makes bundlers treat the absent module as a hard failure.

`config()` is a side-effect import, so **nothing on its path may await**. That is why the
sync entry point resolves the binding through `createRequire` and the envelope is
`node:crypto` rather than Web Crypto. Adding an `await` there breaks
`import "@modootoday/envs/config"` for every consumer.

Commands are values in `src/commands/`: name, description, option specs, `run`. Help is
generated from the spec, so a flag cannot exist in the parser and not the help, and an
option the command did not declare is an **error** rather than a silently ignored typo.
Output goes through `src/cli/ui.ts` — values to stdout so they can be piped, everything
else to stderr, colour only on a TTY without `NO_COLOR`. No dependency for either.

- **Never write a control byte into a source file.** Build it from `String.fromCharCode`
  and reference the constant. This has gone wrong twice here: a NUL in a test fixture and
  raw escape bytes in the colour table.
- better-sqlite3 is an **optional peer**: not installed by this package, so its rows in
  the backend matrix only run where someone installed it. `ENVS_SQLITE_BACKEND` pins one
  backend when you need to exercise a specific path.

### Values are never syntax

Env values are arbitrary text from files this package does not control, so no statement
is ever built from data — no interpolation, no concatenation, parameters only. A guard
test scans every source file for both patterns and proves the detector fires on a
fixture. Two consequences worth keeping in mind:

- Key names reach the database as HMACs and values as sealed blobs, so even the
  identifier surface carries no caller text.
- A string containing a NUL is **refused**. Measured: sqlite TEXT ends at the first NUL,
  so `a\0b` is stored and read back as `a`, losing the rest without an error.

Do not tell a user a command works until it appears in the list above.

## What problem it solves

`dotenv` reads a file and puts it in `process.env`. That is enough until there is more
than one file. Then nobody can answer which file supplied a value, a key defined in two
places silently resolves to one of them, and rotating a credential means finding every
copy.

This package keeps the values in a catalog — a small encrypted SQLite database — and
treats files as inputs to it. Because there is a store rather than a file, it can answer
where a value came from, hold releases and a pointer so a rollback moves the pointer, and
carry an audit trail.

Reach for it when:

- The same key exists in more than one file and you need to know which one wins.
- A value works on one machine and is missing on another.
- A credential must be rotated and you do not know how many copies exist.
- A `.env` path actually points at YAML or JSON and is being read as env anyway.

Do not reach for it to hold one `.env` in one project. `dotenv` is the right size there.

## The format rule, and why it is strict

An env document is a sequence of logical entries, each one of exactly three kinds:

1. a line starting with `#`
2. a blank line
3. `KEY=VALUE`

Entries are logical, not physical: a quoted value may span several lines. Anything that
is not one of the three means the file is not env format, and then **none** of it loads.

This matters because `dotenv` is lenient in ways that produce plausible wrong answers.
Measured against dotenv 17.4.2:

| Input                                      | dotenv                                | this package        |
| ------------------------------------------ | ------------------------------------- | ------------------- |
| `name: envs` over two lines (YAML)         | parses into keys                      | rejected            |
| `KEY: value`                               | `{KEY: "value"}`                      | rejected            |
| `A="oops` unterminated, rest of file valid | `A` becomes `"oops`, rest still loads | whole file rejected |
| `{"a": 1}` (JSON)                          | `{}`, no error                        | rejected            |

Pointing a loader at the wrong file should fail, not return something that looks like
configuration.

## Value syntax

- `VALUE` may be bare, or wrapped in `"`, `'`, or a backtick.
- Inside quotes, `#` and `=` are literal. A bare value ends at the first `#`.
- Whitespace is trimmed only from bare values.
- **Double quotes expand `\n` and `\r` and nothing else.** `\t`, `\\` and `\"` stay
  literal, which is what keeps `"C:\path\to"` intact. Never parse a value with
  `JSON.parse` — it throws on Windows paths and expands escapes dotenv does not.
- Keys are not required to be uppercase. `api_key=secret` is env format. Casing is a
  convention, so `lint` mentions it and the parser does not enforce it.

## Where things live

|                           | Path                                                                                       | Note                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Catalog (source of truth) | `<project>/.envs/catalog.sqlite`                                                           | `~/.envs/` only when there is no project root; `ENVS_CATALOG_PATH` overrides |
| Cache (derived)           | `node_modules/.cache/envs/` when installed, `~/.envs/cache/` under npx or a global install | Safe to delete; rebuilt from the catalog                                     |
| Requirements              | `envs.requires` at the project root                                                        | Committed. Names only, never values                                          |

Two rules follow from this and are worth stating to a user before they are surprised:

- **The catalog stays with the project even under a global install.** Installing the CLI
  with `-g` while the runtime is a devDependency is the ordinary setup; a home-directory
  catalog would mean a value set inside a project is invisible to that project.
- **`.envs/` must be gitignored.** It holds envelopes, history and audit rows. `doctor`
  reports an error, not a warning, if it is ever tracked.

## The global layer

`~/.envs` is a settings layer, not a second store. It holds what belongs to a person and
a machine — a personal API key, `ENVS_PROVIDER`, backup targets — and the loader resolves:

```
process.env  >  project catalog and files  >  ~/.envs
```

The project always wins; the global layer only fills keys the project does not define.
It is switched off with `config({ global: false })` or `ENVS_NO_GLOBAL=1`, and CI should
switch it off, because a build that passes locally on a home-directory value and fails in
CI is the standard failure of this pattern.

## Diagnosing, and repairing a split

`doctor` answers where each value came from and never prints a value.

When it reports keys that exist only in the global layer, there are two repairs and they
move different things:

- `doctor --require <KEY>` records that the key is needed, in `envs.requires`. It carries
  no value, so it can be committed, which is what lets it reach a teammate or CI at all.
  `config()` then throws when a required key resolves nowhere, instead of the application
  receiving `undefined`.
- `doctor --adopt <KEY>` moves the value into the project. Correct only when the value was
  project scoped and had been left global by mistake.

Prefer `--require`. Copying a value into `<project>/.envs/` makes the project
self-contained on one machine only — that directory is gitignored, so a teammate and CI
are exactly where they were. `--adopt --all` is refused by default: personal credentials
are what the global layer exists to hold once, and copying them per project turns one
rotation into many edits.

## Reporting rules

When surfacing anything from this tool to a user:

- **Never print a value.** Report the key, the file, the line, and whether two values are
  the same or different. The existing lint rule `duplicate-key-across-layers` sets the
  convention: same value warns, different value errors, neither prints.
- Say which catalog was actually used. Running in a directory with no project root writes
  to `~/.envs`, and a user who does not notice will look for the value in the wrong place.
