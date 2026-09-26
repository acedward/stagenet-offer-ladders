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

## stkA / stkB / stkC on stagenet

Deployed 2026-09-26 (`deployments/stagenet.json`). The colour is the 32-byte raw token type
that the shielded coins carry.

| Token | Contract address | Colour | Domain | Decimals |
|---|---|---|---|---|
| stkA | `e8551694e54075e139a7910c882e5f9e45418db744414a3d5908e2e95c4c1d67` | `065e530be66eaeb6ebd9aeb60198c0a114ed58928ee4d21ce21b1562f2249934` | `stk:stka` | 6 |
| stkB | `9526b72c34309d2deb426fe5155d601437680f53ca305728a1417b4e8c5eb7e0` | `c62b38bced065214c1f7d9c7ae9041355063559501e186eff4d137bda0f843f7` | `stk:stkb` | 6 |
| stkC | `c03b55f7cf508a0c92ff15049fa3c4638e9b585f635a122254332a32556599b8` | `95778c5f7234237d696969032d8dcfe22936c98927e4d46483c56d11d9c9883b` | `stk:stkc` | 6 |

Anyone can mint: `mint(recipient, amount, nonce)`, where `amount` is in base units
(1 token = 10^6) and `nonce` is 32 bytes, unique per mint. See `contracts/README.md` for the
contract source and build.

## Tools

All of them run in Docker. The funding mnemonic file is passed by path only.

```sh
# compile (pinned compactc 0.34.0, SHA-256 checked); --check verifies managed/ is reproducible
scripts/compile-docker.sh [--check]

# read-only wallet status (public addresses and balances)
FUNDING_WALLET_FILE_HOST=/path/to/mnemonic-file scripts/stagenet-run.sh scripts/wallet-status.ts

# deploy + publishMetadata (resumable; a re-run with nothing to do needs no wallet)
FUNDING_WALLET_FILE_HOST=/path/to/mnemonic-file scripts/stagenet-run.sh scripts/deploy-tokens.ts

# mint: one token, or a batch; --to self or a shielded address (mn_shield-addr_stagenet1…)
FUNDING_WALLET_FILE_HOST=/path/to/mnemonic-file scripts/stagenet-run.sh scripts/mint.ts \
  --token stkA --amount 100 --count 3 --to self
FUNDING_WALLET_FILE_HOST=/path/to/mnemonic-file scripts/stagenet-run.sh scripts/mint.ts \
  --batch stkA:100x3,stkB:1000x1 --to mn_shield-addr_stagenet1... --label my-batch

# secret scan (run before every push); prints PASS or FAIL only
docker run --rm -v "$PWD":/work -v /path/to/mnemonic-file:/secrets/stagenet:ro \
  -e FUNDING_WALLET_FILE=/secrets/stagenet -w /work oven/bun:1.3.11 bun scripts/secret-scan.ts /work
```

`scripts/stagenet-run.sh` starts `midnightntwrk/proof-server:9.0.0-rc.6`, pinned by digest,
on a random free loopback port ≥ 10000. It runs the script in a container that shares the
proof server's network, mounts the mnemonic file read-only, and removes both containers
when the script ends. Each mint is appended to `out/mints.stagenet.jsonl` (git-ignored; it
holds public data only).

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

Two ladders of fixed-price Offer Files, kept valid by a long-running service:

| Ladder | Offer | Slots | Price (want per give) |
|---|---|---|---|
| `AB` | give 100 stkA, want stkB | `AB-01` … `AB-10` | 0.800, 0.844, …, 1.200 (0.8–1.2 × mid 1.0) |
| `BC` | give 100 stkB, want stkC | `BC-01` … `BC-10` | same grid |

Everything is configured in `ladders/stagenet.json` (mid, spread, levels, give amount).
Each offer spends exactly **one pinned coin** (`src/pinned-wallet.ts`, vendored from the
Offer Files kernel) and gives `+100` of the give token for `−round(100 × price)` of the
want token. The service rebuilds an offer when it expires (default every 60 min, which
also refreshes the proof's Merkle root) or is consumed, never while it is live.

### Wallet modes

- **`wallet-per-slot`** (production): slot `AB-01` uses maker wallet `AB-01`. Each maker
  holds one inventory coin of 10 × 100 give tokens; each offer spends that coin and returns
  the change to the maker inside the offer, so after a fill the change funds the next offer.
  When a maker runs out, its slot is `depleted` (not an error).
- **`single-wallet-pinned`** (test, and a future single-wallet setup): all slots share one
  wallet, each pinned to a distinct coin (`includeNonces` / `excludeNonces` in the ladder
  file fix the coin pool). `ladders/stagenet.test.json` is the 3 + 3 slot test ladder.

### Runbook (owner)

The 20 maker wallets already exist. Their mnemonics are only in
`~/.stagenet-offer-ladders/makers.json` (mode 600, directory 700); their public addresses
are in `ladders/makers.stagenet.public.json`.

1. **Fund NIGHT**: send NIGHT to each maker's **unshielded** address (`mn_addr_stagenet1…`,
   the `unshieldedAddress` field). The faucet has a CAPTCHA, so this is by hand.
2. **Register DUST**: `scripts/ladder-run.sh makers:register-dust` registers every maker's
   NIGHT UTxOs for DUST generation, one maker at a time. Idempotent: makers without NIGHT,
   or already registered, are skipped.
3. **Wait for DUST**: `scripts/ladder-run.sh makers:status --slots AB-01,BC-01` (or `all`)
   shows NIGHT, DUST and shielded balances per maker.
4. **Mint inventory**: `scripts/ladder-run.sh makers:mint` self-mints each maker's give
   token (AB → stkA, BC → stkB) as one coin of `INVENTORY_OFFERS` × 100 (default 1,000).
   Idempotent: a maker with a recorded mint (`state/maker-mints.json`), one that already
   holds the amount, or one without DUST is skipped.
5. **Point at the kernel**: once the stagenet kernel is deployed, set `ZSWAP_API`
   (expected `https://stagenet.api-zswap.zkdojo.com`) and register stkA/stkB/stkC there
   (colours in `deployments/stagenet.json`). With `ZSWAP_API` empty the service runs in
   **outbox mode**: offers are built and stored in `state/outbox/`, not posted.
6. **Run**: `cp .env.example .env`, edit, then `docker compose up -d`. Check
   `curl http://127.0.0.1:18080/status` (slot table) and `/health`.

`scripts/ladder-run.sh` runs any command in `oven/bun:1.3.11` with a proof server
(rc.6, pinned by digest) and `~/.stagenet-offer-ladders` mounted at `/state`.

### Commands

| Command | What it does |
|---|---|
| `wallets:generate --count 20 --ladders AB,BC` | create the maker wallets (refuses to overwrite) |
| `wallets:addresses` / `wallets:check` | write / verify the public addresses file |
| `makers:status [--slots …]` | sync makers one at a time; NIGHT, DUST, shielded balances |
| `makers:register-dust [--slots …]` | register NIGHT for DUST generation |
| `makers:mint [--slots …] [--inventory-offers 10]` | self-mint the inventory coin |
| `ladder:once` / `ladder:run` | one reconcile tick / the service loop (SIGTERM stops after the current slot) |
| `offers:verify` | decode the current offers and check them against the journal and the grid |
| `offers:inspect --offer-id …` | decode one stored offer |
| `offers:settle --slot AB-02 --pay-with <nonce>` | test taker: settle a stored offer with the funding wallet, paying with a pinned coin |
| `funding:status` | balances of the funding wallet |

### Before funding all 20 makers: staged rollout (audit C13)

The production shape (20 facades in one process, the change-returning path, kernel mode
against a real kernel) has not run yet. Do it in stages:

1. Fund 2–3 makers only (for example `AB-01`, `AB-02`, `BC-01`), register DUST, mint.
2. Run the service in `wallet-per-slot`, **outbox mode**, with a ladder file listing only
   those slots, for **2+ hours**. Record the process RSS (`docker stats`), the first-tick
   time, and at least one real change-returning build. Set `LADDER_MEM_LIMIT` from it.
3. Before relying on kernel mode unattended, run one real post against the stagenet kernel
   (or FR-006's local devnet + kernel end-to-end) and watch `/status` go `submitted` → `live`.
4. Then fund the rest and use the full `ladders/stagenet.json`.

### Operating rules

- **Never delete the state directory** (`~/.stagenet-offer-ladders/state`: journal, outbox,
  `service.lock`, `maker-mints.json`) while offers are live, and back it up. The journal is
  what stops the service from posting a second live offer on the same coin; the kernel does
  not deduplicate inputs. Compose bind-mounts this host directory, so `docker compose down -v`
  does not delete it; do not replace it with a volume.
- **One process per state directory.** Every `ladder:*` and `makers:*` command takes
  `service.lock` there; stop the service before running `makers:*` commands.
- **A corrupt journal is quarantined**: the service refuses to start until you have checked
  the kernel's live offers for your makers and started once with `JOURNAL_RESET=true`. In
  kernel mode a fresh journal adopts the kernel's matching live offers instead of posting
  twins, and builds nothing while the kernel's list cannot be read.
- **A pending mint is never repeated**: `makers:mint` records the call nonce before
  submitting (`state/maker-mints.json`, version 2; older receipts are migrated). If a maker
  shows `skip-pending-unresolved` (the command exits non-zero), do NOT clear it just because
  the wallet lacks the coin: look up the mint transaction on the indexer (the token
  contract's `mint` call with that nonce). Clear with `makers:mint --clear-pending <slot>`
  only when no such transaction exists and the pending record is older than the transaction
  TTL; if it succeeded, the next run records it once the wallet shows the coin.
- **Proof server**: its image has no shell for a Compose health check. The ladder waits for
  its `/health` at start and exits on a build timeout; if `BUILD_TIMEOUT` repeats, run
  `docker compose restart proof-server`.
- **Fresh journal = explicit acknowledgement.** A journal created from nothing (first
  install, or after one was lost) builds and adopts nothing, and `/health` fails, until you
  start once with `FRESH_START_ACK=<token>`, where the token (`fresh-xxxxxxxx`) is printed in
  the log and on `/status` for THAT journal. Before that, make sure no earlier offer of these
  wallets can still be live or waiting to be indexed: in kernel mode check the kernel's
  `GET /v1/offers?token=<give colour>` for the makers' coins, or wait out the root window.
  A stale value (`true`, or an older journal's token) never acknowledges a new journal; remove
  the variable after the start (the service warns while it is set).
- **Halted slots** (an offer-id or input-nullifier mismatch) keep their coin claimed and fail
  `/health`; `/status` lists them. After checking the offer in the kernel, stop the service
  and run `slots:unhalt --slot AB-01` (re-verify, claim kept) or `slots:unhalt --slot AB-01
  --retire` (you confirmed the old offer is dead; the coin is freed).
- **Locks**: `service.lock` is held by a 30 s heartbeat. Any lock whose heartbeat is younger
  than 90 s is refused, whoever holds it (a live `docker compose run` next to the service is
  refused too); after a crash the next start waits at most about 90 s. If you are certain the
  holder is not running, `BREAK_LOCK=<instance id from the error>` replaces that one lock at
  once. A process whose lock was taken over stops before it builds or posts anything.
- **Root window**: `ROOT_WINDOW_MINUTES` is an upper bound that you set to the network's real
  Merkle-root window. The kernel expires an offer at the root's last-seen time plus that
  window; the service rebuilds on a coin only when the kernel says the offer is expired or
  consumed, or no longer lists it and the bound has passed. An unknown status never frees a
  coin.
- **Version guard**: the service halts (and `/health` fails) when the node's
  `system_version` differs from `EXPECTED_NODE_VERSION` (default `2.0.0-d9729c13`), and also
  while the version cannot be read.
- **Watchdog**: `ladder:run` exits with code 70 when it makes no progress for
  `WATCHDOG_SECONDS`, and after a build that exceeds `BUILD_TIMEOUT_SECONDS`; Compose's
  `restart: unless-stopped` brings it back.
- **Single-wallet mode is for supervised tests only**: the funding wallet is shared with
  other projects; hold its `funding.lock` for the whole run.

### State, health and safety

- Journal and outbox: `$STATE_DIR` (compose: the host directory
  `~/.stagenet-offer-ladders/state`). The journal is written atomically (candidate → fsync
  → rename → directory fsync); a slot's offer is journaled as `stored` before it leaves the
  process, so a crash re-posts the same offer instead of building a second one. Slot states:
  `stored` (in the outbox) → `submitted` (kernel accepted) → `live` (kernel lists it).
- An offer is rebuilt only when it is provably dead: the kernel says expired or consumed,
  or `ROOT_WINDOW_MINUTES` (default 60) has passed since it was built.
- `GET /health` returns `ok` (no data) while the scheduler makes progress;
  `GET /status` returns the slot table (no secrets).
- Kernel refusals (conflict, malformed, not sponsored) are journaled with their code and
  retried only by rebuilding after a backoff; the refused offer is never re-sent.
- The funding wallet is shared: every process that opens it holds
  `~/.stagenet-offer-ladders/funding.lock` (00052's `src/state.ts`). Set
  `FUNDING_LOCK_HELD=true` only when an operator already holds the lock.
- Unit tests: `bun test` (no network).

## License

Apache-2.0 (see `LICENSE`). The token contracts are copies of the reference contracts in
`acedward/mip-0018-midnight-contracts` (Apache-2.0); each copied file names its source
commit.
