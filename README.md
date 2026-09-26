# stagenet-offer-ladders

Test market tooling for the Offer Files kernel on Midnight **stagenet**.

It holds two pieces of work, each delivered as its own pull request:

1. **stkA / stkB / stkC test tokens.** Three shielded tokens, each an instance of the
   reference `NativeShieldedToken` contract from
   [`acedward/mip-0018-midnight-contracts`](https://github.com/acedward/mip-0018-midnight-contracts),
   with its logic unchanged. The repo also holds the deploy tool, the mint tool and the
   deployment record (addresses, colours, transactions). The tokens are **open-mint test
   tokens**: anyone can mint any amount. They have no value.
2. **Offer ladders.** A service that keeps ladders of valid Offer Files in the Offer Files
   kernel, `+stkA → −stkB` and `+stkB → −stkC`, and re-sends them on a schedule. It uses
   the tokens above.

This commit is the scaffold only: layout, pinned dependencies and the secrets policy.

## Layout

| Path | Contents |
|---|---|
| `contracts/` | Compact sources and their compiled `managed/` artefacts |
| `scripts/` | Command-line tools (deploy, mint, checks) |
| `src/` | Shared library code (wallet, providers, service) |

## Runtime

**Bun 1.3.11** (`oven/bun:1.3.11`, the image the Offer Files kernel uses). Scripts are
TypeScript and run directly with `bun <file>.ts`; there is no build step. Everything runs
in Docker:

```sh
docker run --rm -v "$PWD":/work -w /work oven/bun:1.3.11 bun install --frozen-lockfile
docker run --rm -v "$PWD":/work -w /work oven/bun:1.3.11 bun run typecheck
```

Mount the checkout at a path without spaces (`/work` above): some tools break on paths
with spaces.

## Pinned version set (stagenet)

Stagenet runs node `2.0.0-d9729c13` (ledger 9.1 rc.3, `dust/9`). These versions move
**together**. Never mix them with ledger-v9 rc.4, wallet-sdk beta.3, midnight-js beta.8 or
proof server rc.7: those use `dust/10`, and stagenet refuses their fee payments.

| Component | Version |
|---|---|
| Compact compiler | compactc **0.34.0** (language 0.26.0, runtime 0.19.0); the `LFDT-Minokawa/compact` release archive, pinned by SHA-256 |
| `@midnightntwrk/ledger-v9` | 1.0.0-rc.3 |
| `@midnightntwrk/onchain-runtime-v4` | 4.0.0-rc.3 |
| `@midnight-ntwrk/compact-runtime` | 0.19.0 |
| `@midnight-ntwrk/compact-js` | 2.5.5-rc.8 |
| `@midnight-ntwrk/midnight-js-*` | 5.0.0-beta.7 |
| `@midnightntwrk/wallet-sdk-facade`, `-dust-wallet` | 5.0.0-beta.2 |
| `@midnightntwrk/wallet-sdk-shielded`, `-unshielded-wallet`, `-capabilities`, `-address-format` | 4.0.0-beta.2 |
| `@midnightntwrk/wallet-sdk-hd` | 3.1.0-beta.1 |
| `@midnightntwrk/wallet-sdk-abstractions` | 3.0.0-beta.0 |
| `@openzeppelin/compact-contracts` | 0.4.0-alpha.1 |
| Proof server | `midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b` |

`overrides` in `package.json` force a single copy of ledger-v9, onchain-runtime-v4,
compact-runtime, compact-js and platform-js.

`@midnight-ntwrk/testkit-js` is **not used and must not be added**: it logs the wallet
seed at info level. Wallets are built directly from the wallet-sdk sub-packages.

Stagenet endpoints: node RPC `https://rpc.stagenet.shielded.tools` (`wss://` for
wallets); indexer `https://indexer.stagenet.shielded.tools/api/v4/graphql`
(`wss://…/api/v4/graphql/ws`); network id `stagenet`.

## Secrets policy

Nothing secret is ever in this repository: no mnemonic, seed, private key, maker secret
or wallet state. It is kept out as follows:

- **Funding wallet.** Its BIP-39 mnemonic is read at runtime from a **file path** given
  in an environment variable. The file must be a regular file with mode 600. It may hold
  the bare phrase or a `WALLET="<words>"` line. In Docker, mount the file read-only and
  pass only its path. The phrase itself is never put in an environment variable's value
  or on a command line (both are visible in `ps` and `docker inspect`), and it is never
  logged or written anywhere.
- **Maker wallets and service state** (ladder service) live under
  `$HOME/.stagenet-offer-ladders/`: a mode-700 directory with mode-600 files, outside every
  Git working tree.
- **Output.** The tools print and record only public data: addresses, public keys,
  balances, contract addresses, colours and transaction hashes.
- **Guards.** `.gitignore` excludes `.env*`, `*.mnemonic`, `secrets/`, `.stagenet`,
  `out/` and journals. A secret scan runs before every push: it reads the mnemonic in
  memory and fails if any three consecutive words of it, a `WALLET=` assignment or a
  64-byte hex seed appear in the tree, `out/` or the logs.
- **One process per wallet.** Two wallet sessions on one mnemonic against one node
  disrupt each other. Run on-chain steps one at a time.

## Offer ladders (project 00053)

Two ladders of fixed-price offers, `AB` (give stkA, want stkB) and `BC` (give stkB, want
stkC), 10 levels each from 0.8 × mid to 1.2 × mid (`ladders/stagenet.json`). Each offer
spends exactly one pinned coin (`src/pinned-wallet.ts`, vendored from the Offer Files
kernel) and is re-built when it expires or is consumed.

| Module | Role |
|---|---|
| `src/wallets.ts` | maker wallet generation, derivation, the mode-600 secrets file |
| `src/addresses.ts` | the public addresses file (`ladders/makers.stagenet.public.json`) |
| `src/ladder.ts` | price grid, amounts, ladder file |
| `src/journal.ts` | durable per-slot state machine (atomic JSON) |
| `src/scheduler.ts` | reconcile tick: expiry, consumption, re-offer, backoff |
| `src/kernel-client.ts` | `POST /v1/offers`, status reads, retry policy |
| `src/outbox.ts` | built offers (`swapoffer1…`) + metadata; the destination when `ZSWAP_API` is empty |
| `src/offer-builder.ts` | pinned `initSwap` → finalize → encode → exact-coin assertion |
| `src/wallet-session.ts`, `src/ladder-wallet.ts` | wallet facade with a per-wallet pin controller; `wallet-per-slot` and `single-wallet-pinned` modes |
| `src/status.ts` | `GET /health` (no data), `GET /status` (slot table) |

Commands (`bun src/cli.ts <command>`, or `bun run <command>`): `wallets:generate`,
`wallets:addresses`, `wallets:check`, `makers:status`, `ladder:once`, `ladder:run`,
`offers:inspect`; `offers:settle`, `makers:register-dust` and `makers:mint` are in
progress. Unit tests: `bun test` (no network).

## License

Apache-2.0 (see `LICENSE`). The token contracts are copies of the reference contracts in
`acedward/mip-0018-midnight-contracts` (Apache-2.0); each copied file names its source
commit.
