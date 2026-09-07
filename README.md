# @modootoday/envs

Environment values in an encrypted catalog rather than scattered `.env` files.

**[envs.build](https://envs.build)** has the documentation. This page is the introduction.

```console
$ npx @modootoday/envs init
+ catalog created
+ added to .gitignore

Recovery codes — 5, shown once, not stored
  1575H-MPBMP-K41AR-PXAVB-NN920-G
  G8T2M-4KQZR-7VXWD-3NBHE-J05YA-P
  …

$ envs load .env
+ .env 12 keys
+ release 8f21ac04 is current

$ envs run -- node server.js
```

## What it does that a file cannot

`dotenv` reads a file into `process.env`, which is all most projects need. This is for
the ones with four files, three machines, and a credential that gets rotated.

- **Tells you which file set a key.** When `.env` and `.env.local` both declare
  `DATABASE_URL`, `envs doctor` names the one that won. It prints the key and the
  source, never the value.
- **Survives a lost key.** `init` prints five recovery codes once. Any one of them opens
  the catalog on its own, and none of them is ever stored.
- **Refuses a file that is not env format.** `dotenv` reads a two-line YAML document as
  environment variables. This checks first, and if the file fails, nothing loads.
- **Rolls back without deleting anything.** Changing a value writes a new release. Going
  back moves a pointer.

## Migrating from dotenv

`config()` takes the same options — `path`, `encoding`, `override`, `processEnv` — and it
is synchronous, so the side-effect import still works.

```diff
- import "dotenv/config";
+ import "@modootoday/envs/config";
```

Both module systems resolve, so the preload form works without touching your code:

```console
$ node -r @modootoday/envs/config server.js
```

One difference worth knowing before you switch: `dotenv` returns quietly when there is no
file, while this throws when there is no catalog. A missing store is the failure this
exists to make visible, so it is loud rather than empty.

The command names follow dotenvx: `run -- cmd`, `get`, `set`, `ls`, `rotate`. If you have
used it, most of this is already familiar.

## Documentation

|                                                           |                                |
| --------------------------------------------------------- | ------------------------------ |
| Getting started                                           | <https://envs.build/guide/>    |
| The format rule, measured against dotenv                  | <https://envs.build/format/>   |
| Recovery codes                                            | <https://envs.build/recovery/> |
| How it compares to dotenv, dotenvx, Doppler and Infisical | <https://envs.build/compare/>  |
| Sharing a catalog, and what the server cannot see         | <https://envs.build/hosted/>   |
| All 28 commands                                           | <https://envs.build/commands/> |

## Requirements

Node.js 22 or Bun 1.3. Nothing to sign up for, and no network call unless you ask for one.

## Before you commit to it

- **The licence is not OSI open source.** See below.
- **It starts slower than dotenv** — about 6.6 ms for a hundred keys against 0.2 ms.
- **One `.env` and one developer does not need this.** dotenv already does that job, with
  no key to manage and nothing to back up.

## Licence

Elastic License 2.0. Licensor: **modootoday**. See [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE), and <https://envs.build/licence/>.

Use it inside your company at any scale, ship it in a product you sell, fork it. What you
cannot do is offer this software to third parties as a hosted or managed service. It
carries a patent grant with a retaliation clause: asserting patent claims over this
software ends your licence.

---

Repository <https://github.com/modootoday/envs> · npm
[`@modootoday/envs`](https://www.npmjs.com/package/@modootoday/envs)
