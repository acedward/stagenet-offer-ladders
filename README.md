# stagenet-offer-ladders

Test market tooling for the Offer Files kernel on Midnight **stagenet**.

It holds these pieces of work:

1. **stkA / stkB / stkC test tokens.** Three shielded tokens, each an instance of the
   reference `NativeShieldedToken` contract from
   [`acedward/mip-0018-midnight-contracts`](https://github.com/acedward/mip-0018-midnight-contracts),
   with its logic unchanged. The repo also holds the deploy tool, the mint tool and the
   deployment record (addresses, colours, transactions). The tokens are **open-mint test
   tokens**: anyone can mint any amount. They have no value.
2. **Offer ladders.** A service that keeps ladders of valid Offer Files in the Offer Files
   kernel, `+stkA → −stkB` and `+stkB → −stkC`, and rebuilds each one when the old one is
   provably dead (on stagenet: after 14 days, see "Root window"). It uses the tokens above.
3. **Stock/USDC books** (project 00057, same PR as 2). The same service quotes wStkA/wUSDC and
   wStkB/wUSDC on both sides at cent prices, with the tokens bridged from Sepolia (AA 00037).
   The 20 existing maker wallets are reused. See "Stock/USDC books" below.
4. **T-bill books** (project 00058). The same service sells the bridged test T-bills TB13W,
   TB26W and TB52W for wUSDC at fixed prices, 10 tokens per offer, from 9 new maker wallets
   added with `wallets:add`. See "T-bill books" below.

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
| `e2e/` | Local end-to-end test of the stock/USDC books on an `undeployed` devnet |

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

> **Since 2026-09-27 the running service quotes the 00057 stock/USDC books** (`LADDER_FILE=ladders/stagenet.usdc.json`, see "Stock/USDC books" below), and since 20:57 UTC that day it **posts them to the stagenet kernel** (`ZSWAP_API=https://stagenet.api-zswap.zkdojo.com`, "Runbook (books)" step 7). The AB/BC grid ladders described here are retired: they were never posted, and their journal is archived. The service, its modes and its operating rules are unchanged.

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
5. **Point at the kernel**: the stagenet kernel is live at
   `https://stagenet.api-zswap.zkdojo.com` (site `https://stagenet.zswap.zkdojo.com/`). Set
   `ZSWAP_API` to it; for the books this is "Runbook (books)" step 7. Registering token names
   on the kernel is the kernel operator's job and is not needed to post: on 2026-09-27 it
   accepted the unregistered wStkA/wStkB/wUSDC colours. With `ZSWAP_API` empty the service
   runs in **outbox mode**: offers are built and stored in the outbox directory, not posted.
6. **Run** (from the repository directory):
   - `cp .env.example .env`, then edit it: `LADDER_FILE` with its own `JOURNAL_FILE` and
     `OUTBOX_DIR` (the example defaults are the live books), `LADDER_MEM_LIMIT` (2g is enough
     for 20 makers, see below) and a free `STATUS_HOST_PORT`. Keep comments on their own
     lines (Compose reads `KEY=   # text` as the value `# text`).
   - `docker compose up -d`. The first start of a new journal builds nothing and `/health`
     answers 503; the log and `/status` show a token (`phase=fresh-start
     result=unacknowledged token=fresh-xxxxxxxx`). Once no earlier offer of these wallets can
     still be live, set `FRESH_START_ACK=fresh-xxxxxxxx` in `.env` and run `docker compose up
     -d` again (the log says `result=acknowledged`); then set `FRESH_START_ACK=` back to empty
     and `docker compose up -d` once more.
   - Status: `curl -s http://127.0.0.1:$STATUS_HOST_PORT/status` (slot table),
     `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$STATUS_HOST_PORT/health`,
     `docker compose ps`, `docker compose logs -f --tail 50 ladder`.
   - Stop: `docker compose stop` (or `docker compose down`; the journal and outbox are in
     the host directory and survive both). Start again: `docker compose up -d`.
   - Check the stored offers without touching the live journal (decodes every current
     offer and checks it against the journal and the grid; prints PASS or FAIL):

     ```sh
     mkdir -p ~/.stagenet-offer-ladders/verify-copy
     cp -R ~/.stagenet-offer-ladders/state/ladder.wallet-per-slot.journal.json \
       ~/.stagenet-offer-ladders/state/outbox ~/.stagenet-offer-ladders/verify-copy/
     STATE_SUBDIR=verify-copy scripts/ladder-run.sh offers:verify
     ```

`scripts/ladder-run.sh` runs any command in `oven/bun:1.3.11` with a proof server
(rc.6, pinned by digest) and `~/.stagenet-offer-ladders` mounted at `/state`.

### Commands

| Command | What it does |
|---|---|
| `wallets:generate --count 20 --ladders AB,BC` | create the maker wallets (refuses to overwrite) |
| `wallets:add --ladders T13,T26,T52 --count 9` | append new maker wallets to the existing secrets file (backup first, old entries byte-identical; 00058) |
| `wallets:addresses` / `wallets:check` | write / verify the public addresses file |
| `makers:status [--slots …]` | sync makers one at a time; NIGHT, DUST, shielded balances |
| `makers:register-dust [--slots …]` | register NIGHT for DUST generation |
| `makers:mint [--slots …] [--inventory-offers 10]` | self-mint the inventory coin (00053 grid ladders) |
| `makers:fund --ladder-file … [--dry-run] [--batch-size 5] [--check-balances]` | send each book maker its inventory from the funding wallet (00057) |
| `ladder:once` / `ladder:run` | one reconcile tick / the service loop (SIGTERM stops after the current slot) |
| `offers:verify` | decode the current offers and check them against the journal and the grid |
| `offers:inspect --offer-id …` | decode one stored offer |
| `offers:settle --slot AB-02 --pay-with <nonce> [--dry-run]` | test taker: settle a stored offer with the funding wallet, paying with a pinned coin; `--dry-run` balances, proves and finalizes it, reports the fee and size, and does not submit (00058) |
| `funding:status` | balances of the funding wallet |

### Staged rollout (audit C13) — done in outbox mode on 2026-09-27

The production shape runs in stages. Stages 1 and 2 ran on stagenet on 2026-09-27 (plan
00053 P12), in `wallet-per-slot` **outbox mode** through `docker compose`:

1. **Stage 1: 3 makers** (`ladders/stagenet.stage1.json`: the full ladder with
   `"onlySlots": ["AB-01", "AB-02", "BC-01"]`, so each slot keeps its full-ladder price and
   the journal carries over to stage 2). Measured with `LADDER_MEM_LIMIT=4g`:
   - RSS 387–430 MiB over 67 min (≈ 0.39 GiB before any wallet opens, ≈ 10–17 MiB per open
     wallet); the proof server uses ≈ 0.7 GiB after its first proof;
   - first tick 322 s: each wallet's first full sync takes ≈ 105 s, a build ≈ 1.7–1.9 s;
   - 3 change-returning offers (one input: the maker's 1,000-token coin; +100 given, 900
     back as change inside the offer; ≈ 15.5 KB each), `offers:verify` PASS at 0.800 /
     0.844 / 0.800;
   - the fresh-start ack flow, and restarts without a rebuild (a restart while idle takes
     the lock at once; after a kill in the middle of a wallet sync, the new process waits
     ≈ 90–110 s for the old lock to go stale, restarting a few times meanwhile).
2. **Stage 2: all 20 makers** (`ladders/stagenet.json`, same journal, no reset). Measured
   with `LADDER_MEM_LIMIT=2g`:
   - all 20 offers stored **36.5 min** after the start (one wallet sync + build at a time);
     the three stage-1 offers were kept, not rebuilt;
   - RSS 362 MiB at start, **≈ 0.71–0.72 GiB** with 20 wallets open: 2g leaves ≈ 2.8×;
   - `offers:verify` 20/20 PASS: AB at 0.800 … 1.200 (want 80 … 120 stkB), BC the same in
     stkC.
3. **Kernel mode: done on 2026-09-27 for the books** ("Runbook (books)" step 7). One stored
   offer was posted by hand first and listed `live`; then `ZSWAP_API` was set and the ladder
   recreated. The stored offers were published as they were (no rebuild).

`Wallet.Sync: [object CloseEvent]` lines with a stack trace in the log are the wallet SDK
reporting an indexer websocket that closed; the SDK reconnects by itself (exponential
retry, at most 2 min apart). They need no action unless `/status` shows slots whose wallet
stays unreadable.

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
  - **Stagenet: `ROOT_WINDOW_MINUTES=20160`** (the default, and in `.env.example`). Stagenet
    runs ledger 9, which keeps zswap Merkle roots for `global_ttl` = 1,209,600 s = **14
    days**, so an offer stays settleable for up to 14 days after it is built.
  - The original "re-send the offers hourly" plan assumed ledger 7/8's 1-hour window. With
    14 days there is nothing to re-send each hour: the kernel keeps an offer listed until it
    expires (or is taken), and if the kernel stops listing an offer early, the service
    re-posts the **same** stored blob (no rebuild, no second offer on the coin). A coin gets a
    new offer only after the old one is provably dead. `OFFER_TTL_MINUTES` is bookkeeping.
  - In outbox mode (no kernel), each stored offer is rebuilt after 14 days plus
    `EXPIRY_GRACE_SECONDS`.
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
  or the kernel does not list it and `ROOT_WINDOW_MINUTES` (default 20160 = 14 days) plus
  `EXPIRY_GRACE_SECONDS` (default 300, a margin for the root's last-seen time) have passed
  since it was built. In outbox mode (never published) the same bound applies. An unknown
  kernel status never frees a coin.
- `GET /health` returns `ok` (no data) while the scheduler makes progress;
  `GET /status` returns the slot table (no secrets).
- Kernel refusals (conflict, malformed, not sponsored) are journaled with their code and
  retried only by rebuilding after a backoff; the refused offer is never re-sent.
- The funding wallet is shared: every process that opens it holds
  `~/.stagenet-offer-ladders/funding.lock` (00052's `src/state.ts`). Set
  `FUNDING_LOCK_HELD=true` only when an operator already holds the lock.
- Unit tests: `bun test` (no network).

## Stock/USDC books (project 00057)

The service quotes two stock/USDC markets on both sides, at cent prices (about 100 stocks
per USDC, mid 0.0100). The book is `ladders/stagenet.usdc.json`:

| Pair | Side | Ladder | Maker gives → wants | Levels (USDC per stock) | Size per offer | Each maker holds | Makers |
|---|---|---|---|---|---|---|---|
| wStkA/wUSDC | ask (a taker buys A) | `AASK` | wStkA → wUSDC | 0.0104, 0.0108, 0.0112, 0.0116, 0.0120 | 100 wStkA (1.04–1.20 wUSDC) | 1,000 wStkA (10 fills) | AB-01…05 |
| wStkA/wUSDC | bid (a taker sells A) | `ABID` | wUSDC → wStkA | 0.0096, 0.0092, 0.0088, 0.0084, 0.0080 | 1 wUSDC (104.17–125 wStkA) | 2 wUSDC (2 fills) | AB-06…10 |
| wStkB/wUSDC | ask | `BASK` | wStkB → wUSDC | as for A | 100 wStkB | 1,000 wStkB | BC-01…05 |
| wStkB/wUSDC | bid | `BBID` | wUSDC → wStkB | as for A | 1 wUSDC | 2 wUSDC | BC-06…10 |

- The best ask is 0.0104 and the best bid 0.0096 on both pairs (8 % spread). Slot `AASK-01` is
  the best ask and `ABID-01` the best bid.
- Makers receive in total 5,000 wStkA, 5,000 wStkB and 20 wUSDC.
- The makers' native stkA/stkB coins stay unused: a slot only ever pins a coin of its give
  colour.
- After fills, ask makers accumulate wUSDC and bid makers accumulate wStk. Those proceeds are
  not offered, and a maker whose give inventory runs out is `depleted` (not an error).

### Book ladders in the ladder file

A ladder entry is either a **grid** (`give`, `want`, `mid`, `spread`, `levels`; 00053,
unchanged) or a **book** side:

```json
{ "id": "ABID", "side": "bid", "base": "wStkA", "quote": "wUSDC",
  "prices": ["0.0096", "0.0092", "0.0088", "0.0084", "0.0080"],
  "giveTokens": "1", "inventoryTokens": "2",
  "wallets": ["AB-06", "AB-07", "AB-08", "AB-09", "AB-10"] }
```

- **`prices`** are exact decimals in quote per base, best level first: asks strictly rising,
  bids strictly falling.
- **Orientation**:
  - an `ask` gives `giveTokens` of base for `ceil(give × price)` of quote;
  - a `bid` gives `giveTokens` of quote for `ceil(give / price)` of base.

  Both round up, so a maker never trades beyond its level. The bid want amounts are
  104,166,667 / 108,695,653 / 113,636,364 / 119,047,620 / 125,000,000 base units.
- **Crossing**: a file whose lowest ask is not above its highest bid, per pair, is refused.
- **`wallets`** maps each level to a maker wallet id in `makers.json`. By default the wallet id
  is the slot id, as in 00053. Two slots can never share a wallet.
- **`inventoryTokens`** is what `makers:fund` sends each maker.
- **Token colours**:
  - A token with `"bridge": {"vault", "erc20"}` must carry exactly
    `tokenType(vaultTokenDomainSeparator(erc20), vault)`; every command that loads the file
    checks this (`src/bridge.ts`).
  - A colour that starts with `PENDING` is refused with a "fill it in" error, so a token that is
    not bridged yet can sit in a file without being quoted by mistake.

### Canonical addresses

| What | Value |
|---|---|
| wStkA colour (bridged stkA) | `5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02` |
| wStkB colour (bridged stkB) | `e7ca18cb056477a5aca5cce387306d56526c2f226b4a4e34f068e3a3e8179588` |
| wUSDC colour (bridged Circle USDC) | `e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d` |
| Bridge vault (Midnight stagenet, AA 00037) | `7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637` |
| Vault's EVM account (Sepolia, chain 11155111) | `0x648216975e722494bFF92E88FFc68C8F8d438FaA` |
| stkA ERC20 (Sepolia, 6 decimals) | `0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52` |
| stkB ERC20 (Sepolia, 6 decimals) | `0xF2bEFf36543219C8feC2AB2f42070AA65D3C844B` |
| Circle USDC (Sepolia, 6 decimals) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Native stkA / stkB / stkC (00052) | contracts and colours in the table at the top (`deployments/stagenet.json`) |
| Maker public addresses | `ladders/makers.stagenet.public.json` (20 wallets AB-01…10, BC-01…10) |
| Stagenet Offer Files kernel API (`ZSWAP_API`) | `https://stagenet.api-zswap.zkdojo.com` |
| Stagenet Offer Files site | `https://stagenet.zswap.zkdojo.com/` |

| Ladder file | What it is for |
|---|---|
| `ladders/stagenet.usdc.json` | the 00057 stock/USDC books: 4 ladders × 5 levels on the 20 makers |
| `ladders/stagenet.json` | the 00053 native grid ladders AB (stkA → stkB) and BC (stkB → stkC); retired by 00057, kept for `makers:mint` / `makers:register-dust` |
| `ladders/stagenet.stage1.json` | the 00053 staged rollout (3 slots of the grid) |
| `ladders/stagenet.test.json` | the 00053 single-wallet test ladder (funding wallet, coin pool) |

### Runbook (books)

Run the commands from the repository directory. `scripts/ladder-run.sh` mounts
`~/.stagenet-offer-ladders`, and the funding mnemonic file by path only
(`FUNDING_WALLET_FILE_HOST`).

1. **Colours.** All three colours are the ones AA 00037 recorded
   (`deployments/stagenet-vault.json` in
   [acedward/passport PR #4](https://github.com/acedward/passport/pull/4)), and every load of the
   file checks them against the vault derivation. A new bridged token goes in with its recorded
   colour and its `bridge` block; `bun test test/book.test.ts` checks it.
2. **Funding plan (no wallet opened):**

   ```sh
   scripts/ladder-run.sh makers:fund --ladder-file ladders/stagenet.usdc.json --dry-run
   ```

   It prints, per maker, the wallet, the token, the amount and the decision, and the totals
   per token.
3. **Fund the makers** (shielded transfers from the funding wallet; holds `funding.lock`; fee
   margin 5; batches of 5 makers per token, one transaction each):

   ```sh
   FUNDING_WALLET_FILE_HOST=/path/to/funding-mnemonic-file \
     scripts/ladder-run.sh makers:fund --ladder-file ladders/stagenet.usdc.json
   ```

   - It opens no maker wallet, so it can run while the service holds the makers.
   - Every transfer is recorded in `state/maker-funding.json`: `pending` with its
     identifier before it is submitted, `sent` with hash and block after. A second run moves
     nothing.
   - A `skip-pending-unresolved` maker (the command exits non-zero) was never confirmed by
     the indexer. Look the identifier up before `--clear-pending <wallet id>`.
   - With the service stopped, `--check-balances` also syncs each recipient and skips makers
     that already hold their inventory.
   - Balances afterwards: `scripts/ladder-run.sh makers:status --slots AB-01,AB-06` (service
     stopped) or `/status` inventory (service running on the books).
4. **Switch the service to the books** (a fresh journal; nothing of the 00053 state is moved
   or deleted):
   1. `docker compose down`.
   2. Archive the state directory:
      `cp -a ~/.stagenet-offer-ladders/state ~/.stagenet-offer-ladders/state-archive-o53-$(date -u +%Y%m%dT%H%M%SZ)`.
   3. In `.env` set:

      ```
      LADDER_FILE=ladders/stagenet.usdc.json
      JOURNAL_FILE=/data/ladder.books.journal.json
      OUTBOX_DIR=/data/outbox-books
      ```

      and a new `IMAGE_TAG`. The book needs its own journal. A start on the 00053 journal is
      refused, because that journal still holds offers for slots the book does not have.
   4. `docker compose up -d --build`, then follow the fresh-start acknowledgement in the
      runbook above: the first start prints `fresh-xxxxxxxx`; set `FRESH_START_ACK` to it, start
      again, then empty it and start once more.
   5. To go back, restore the previous `.env` values. The 00053 journal and outbox are where
      they were.
5. **Verify** without touching the live journal:

   ```sh
   mkdir -p ~/.stagenet-offer-ladders/verify-copy
   cp -R ~/.stagenet-offer-ladders/state/ladder.books.journal.json \
     ~/.stagenet-offer-ladders/state/outbox-books ~/.stagenet-offer-ladders/verify-copy/
   STATE_SUBDIR=verify-copy JOURNAL_FILE=/data/ladder.books.journal.json OUTBOX_DIR=/data/outbox-books \
     scripts/ladder-run.sh offers:verify --ladder-file ladders/stagenet.usdc.json
   ```

   It prints PASS or FAIL, and checks:
   - every offer's legs against its level;
   - every journal slot's wallet, colours and amounts against the book;
   - per pair (`books`), the best bid and best ask, which must not cross, and the depth.

   `/status` shows the same `books` summary live, plus each slot's `side`, `pair` and `price`.
6. **Take an offer as a taker** (test; the funding wallet pays with a pinned coin of the
   offer's want colour). Coin nonces come from `funding:status`. `offers:settle` takes
   `service.lock`, so while the service runs it reads a **fresh** copy of the state: make the
   copy again as in step 5 first, then:

   ```sh
   FUNDING_WALLET_FILE_HOST=/path/to/funding-mnemonic-file STATE_SUBDIR=verify-copy \
     JOURNAL_FILE=/data/ladder.books.journal.json OUTBOX_DIR=/data/outbox-books \
     scripts/ladder-run.sh offers:settle --ladder-file ladders/stagenet.usdc.json --slot AASK-01 --pay-with <wUSDC coin nonce>
   ```

   Buying `AASK-01` pays 1.04 wUSDC for 100 wStkA. Selling into `ABID-01` pays 104.166667
   wStkA for 1 wUSDC. The running service sees the maker's coin spent, marks the slot
   `consumed` and re-offers from the change coin within a reconcile interval.

7. **Kernel mode: post the books to the stagenet kernel** (live since 2026-09-27 20:57 UTC).
   The switch builds nothing: the stored outbox blobs are published as they are.
   1. First check that the kernel accepts the book's colours. Post one stored offer by hand;
      these are the exact bytes the service would send, and all of it is public data:

      ```sh
      K=https://stagenet.api-zswap.zkdojo.com
      ID=$(curl -s http://127.0.0.1:$STATUS_HOST_PORT/status | jq -r '.slots[] | select(.slot=="AASK-01") | .offerId')
      jq -c '{offer: .blob}' ~/.stagenet-offer-ladders/state/outbox-books/$ID.json \
        | curl -s -X POST -H 'content-type: application/json' --data-binary @- $K/v1/offers
      curl -s $K/v1/offers/$ID/status
      ```

      - An answer of `{"success":true,"offerId":"<ID>",…}` (or `409 DUPLICATE_OFFER`) means
        the offer was accepted. Its status turns `live` within about 30 s.
      - A refusal (`422 UNPRICED_TOKEN` or `NOT_SPONSORED`, or a `400` code) means: do not
        switch. The kernel operator must allow unpriced tokens (`BATCHER_SPONSOR_UNPRICED=allow`)
        or give the tokens a price.
   2. In `.env`, set `ZSWAP_API=https://stagenet.api-zswap.zkdojo.com`, with no comment on that
      line. Then recreate only the ladder: `docker compose up -d --timeout 150 ladder`. Never
      use `down -v`, and never reset the journal.
   3. Watch the switch:
      - Tick 1 opens the makers one at a time, about 115 s each. Each `stored` slot is
        published right after its wallet syncs, so the first post comes about 2 min after the
        start and the last about 40 min after.
      - `/status` shows each slot go `stored` → `submitted` → `live`. A slot turns `live` on
        its next reconcile, once the kernel's `inputNullifiers` match the pinned coin. For the
        slots posted in tick 1 that is tick 2, which starts after the last wallet has opened.
        A slot you posted by hand goes straight from `stored` to `live`.
      - `curl -s $K/v1/offers | jq '.offers | length'` counts the listed offers.
   4. **A refusal after the switch** shows in the log as `phase=post … result=rejected`, and in
      `/status` as `rejected`. The service would rebuild a rejected slot on the same coin and
      post it again with a doubling backoff (60 s × 2^(n−1), capped at 60 min). Revert at once:
      set `ZSWAP_API=` (empty) in `.env` and run `docker compose up -d --timeout 150 ladder`.
      That returns the service to outbox mode, and the journal keeps the coins claimed.
   5. **Slow answers are not refusals.** A POST can take longer than the client's 30 s
      timeout. The client then posts the same blob again. In the one case seen, the kernel
      answered the re-posts with `500 INTERNAL` for about 30 s, then with `409 DUPLICATE_OFFER`,
      which counts as accepted. The client makes 6 attempts per call. If all 6 fail, the
      service posts the same blob again after `SUBMIT_CONFIRM_SECONDS`; it never builds a new
      offer for this.
   6. **Measured on 2026-09-27**: the hand post of `AASK-01` answered `200` in 7.4 s, and the
      offer was `live` 24 s later. The service was recreated at 20:57:31 UTC. Tick 1 posted
      the other 19 offers in 41.7 min: 18 were accepted on the first attempt, and one was
      answered `DUPLICATE_OFFER` after a timeout and four `500 INTERNAL`. Nothing was
      refused. All 20 were `live` at 21:40, `GET /v1/offers` listed exactly the service's 20
      ids, and the ladder's RSS was 675 MiB. The first fill through the kernel (another
      client bought `AASK-01` at 21:25) was re-offered from the maker's change on the next
      tick.

### Local end-to-end (`e2e/local-books.sh`)

The same flow runs on a throwaway local chain in Docker: `e2e/local-books.sh` (about 10
minutes; everything it writes goes to a temporary run directory, printed at the end). The
stack is `e2e/compose.local.yml`, run under a unique project name, with host ports on
127.0.0.1 ≥ 10000. It has:

- node `midnight-node` 2.0.0-rc.4, `CFG_PRESET=dev` (the same `2.0.0-d9729c13` build as
  stagenet);
- indexer 4.4.0-rc.3 (the `midnight-2-offers/indexer:local` image, built from the
  effectstream/binaries 0.3.120 executable);
- proof server rc.6;
- the service from this checkout.

Nothing is pulled: the images must be local.

The run:

1. The funding wallet is Midnight's public dev test wallet, prefunded by the dev genesis. It
   deploys this repository's stkA and stkB contracts as stand-in wStkA and wUSDC, and mints
   to itself.
2. Four throwaway makers receive their inventory through `makers:fund`. A second run moves
   nothing, and `--check-balances` finds every maker funded.
3. The service stores the committed book's first two ask and bid levels (fresh-start ack),
   and `offers:verify` passes.
4. A taker buys `AASK-01` and sells into `ABID-01` with exact balance deltas.
5. Both slots re-offer from their change, and a restart builds nothing.
6. The stack is removed with `down -v`.

## T-bill books (project 00058)

The service also sells three bridged test T-bills for wUSDC at the owner's **fixed** prices,
10 tokens per offer. The ladder file is `ladders/stagenet.books.json`: the T-bill ladders
first, then the four 00057 ladders copied unchanged from `ladders/stagenet.usdc.json` (which
stays as it is).

| Pair | Price (wUSDC per token) | Offer (raw units) | Ladders (one level each) | Makers | Each maker holds |
|---|---|---|---|---|---|
| TB13W/wUSDC | 0.9899 | gives 10,000,000 TB13W, wants 9,899,000 wUSDC | `T13A`, `T13B`, `T13C` | T13-01…03 | 100 TB13W (10 fills) |
| TB26W/wUSDC | 0.9905 | gives 10,000,000 TB26W, wants 9,905,000 wUSDC | `T26A`, `T26B`, `T26C` | T26-01…03 | 100 TB26W |
| TB52W/wUSDC | 0.9806 | gives 10,000,000 TB52W, wants 9,806,000 wUSDC | `T52A`, `T52B`, `T52C` | T52-01…03 | 100 TB52W |

- **Asks only**: the makers sell T-bills; `/status` `books` shows each pair's best ask and a
  `null` best bid.
- **Fixed price, several offers**: a ladder's prices must be strictly monotonic, so each
  offer at the same price is its own one-level ladder with its own maker wallet (one wallet
  per offer). Slot ids are `T13A-01`, `T13B-01`, … .
- **Order**: the T-bill ladders come first in the file, so the first tick after a restart
  posts them before it reconciles the 20 stock slots.
- **The new makers get no NIGHT.** Making an offer is fee-free for a maker, so they post
  normally; they cannot move tokens out, or retire an offer by spending its coin, until
  someone funds them with NIGHT.
- **A price is fixed for a slot's life** (the journal refuses a changed definition), and the
  service never cancels offers. A new price needs new slots.

| What | Value |
|---|---|
| TB13W colour (Test T-Bill 13-week) | `b3d96e9933fb4548ce8a17a63f4c92bb3894b3571873c3edcc8a08aa7ce2512b` |
| TB26W colour (Test T-Bill 26-week) | `7b044b55c0493a67eeb16f25d3757eea07f9abaf55e374739953afd449bc3b62` |
| TB52W colour (Test T-Bill 52-week) | `8f4798a5ee48747f37562da76ed8711ad4b4ea1ad7ac16d80eb74b92792b9ec2` |
| TB13W / TB26W / TB52W ERC20 (Sepolia, 6 decimals) | `0x5cF366decA552c30eBB2504d0b9Ee104A99f1c72` / `0x26dB7221903e62310409e454442adBb46E0B6E33` / `0x02A0D1BaF66351715A84aC4763b82f1155BdD5b0` |
| Bridge vault and records | the vault above (`7771c9e5…d637`); [acedward/passport PR #4](https://github.com/acedward/passport/pull/4) (AA 00045) |
| Ladder file | `ladders/stagenet.books.json` (the T-bill books + the 00057 stock books) |

### Adding tokens and makers (00058)

Run the commands from the repository directory. The checkout needs its `node_modules`
(once: `docker run --rm -v "$PWD":/work -w /work oven/bun:1.3.11 bun install --frozen-lockfile`).
The running service is not touched until step 6.

1. **The ladder file.** Add each token with its recorded colour and `bridge` block (every load
   checks the colour against the vault derivation), then one ladder per offer; give each
   ladder a new wallet id in `wallets`. Check it: `bun test test/tbill-books.test.ts` (in
   Docker) or `scripts/ladder-run.sh makers:fund --ladder-file <file> --dry-run`.
2. **Add the maker wallets** to the existing secrets file. `wallets:add` needs the secrets
   *directory* mounted read-write (it writes a backup and replaces the file with a rename), so
   it runs in its own container rather than through `scripts/ladder-run.sh`:

   ```sh
   shasum -a 256 ~/.stagenet-offer-ladders/makers.json   # record it; never print the contents
   docker run --rm -v "$PWD":/work -w /work \
     -v "$HOME/.stagenet-offer-ladders":/secrets-dir -e MAKERS_FILE=/secrets-dir/makers.json \
     oven/bun:1.3.11 bun src/cli.ts wallets:add --ladders T13,T26,T52 --count 9
   ```

   - It refuses a missing file, a network mismatch, any wallet id that already exists, and a
     file that is not in the form `wallets:generate` writes.
   - It writes `makers.json.bak-<UTC stamp>` (mode 600) first, then the merged file (temp
     600 → fsync → rename → fsync of the 700 directory). Every existing entry keeps its order
     and bytes: the new file starts with the old bytes up to the last old entry
     (`preservedPrefix` in the output), and the new entries follow.
   - It prints the new wallet ids and unshielded addresses, the counts and sha256s before and
     after, and the backup path. It never prints a mnemonic.
   - Never edit, move or regenerate `makers.json` by hand: it holds the only copy of the
     funded makers' keys. Keep the backup.
3. **Check and publish the addresses**:

   ```sh
   docker run --rm -v "$PWD":/work -w /work \
     -v "$HOME/.stagenet-offer-ladders/makers.json":/secrets/makers.json:ro \
     -e MAKERS_FILE=/secrets/makers.json -e MAKERS_DIR_CHECK=false \
     oven/bun:1.3.11 bun src/cli.ts wallets:addresses --ladder-file ladders/stagenet.books.json
   # the same mounts, then: bun src/cli.ts wallets:check   → "result": "PASS"
   ```

   `wallets:addresses` rewrites `ladders/makers.stagenet.public.json` (public keys and
   addresses only; each maker shows the price of the slot that uses it). `wallets:check`
   re-derives every wallet and must match that file; the old makers' addresses do not
   change.
4. **Fund the new makers** from the funding wallet (shielded transfers; no maker wallet is
   opened, so the service can keep running). Record the transfers in a separate state
   directory, seeded with the live records, so the running service's directory is not
   written to:

   ```sh
   mkdir -m 700 ~/.stagenet-offer-ladders/o58-funding
   cp -p ~/.stagenet-offer-ladders/state/maker-funding.json ~/.stagenet-offer-ladders/o58-funding/
   SLOTS=T13A-01,T13B-01,T13C-01,T26A-01,T26B-01,T26C-01,T52A-01,T52B-01,T52C-01
   STATE_SUBDIR=o58-funding scripts/ladder-run.sh makers:fund --ladder-file ladders/stagenet.books.json --slots $SLOTS --dry-run
   FUNDING_WALLET_FILE_HOST=/path/to/funding-mnemonic-file STATE_SUBDIR=o58-funding \
     scripts/ladder-run.sh makers:fund --ladder-file ladders/stagenet.books.json --slots $SLOTS
   ```

   The dry run lists 9 × `send` of 100 tokens; the real run sends 2 batches (5 + 4 makers,
   one transaction per token and batch); a second run is all `skip-already-sent`. When the
   service is switched (step 6), merge the new `sent` records into
   `state/maker-funding.json` so later runs from the default directory see them.
5. **Prove a zero-DUST maker's offer without posting it** (outbox mode with `ZSWAP_API`
   unset, a scratch state directory, a scratch ladder file with `"onlySlots": ["T13A-01"]` kept out of git, e.g. under
   `out/`):

   ```sh
   STATE_SUBDIR=o58-scratch LADDER_FILE=out/scratch.json \
     scripts/ladder-run.sh ladder:once                        # prints the fresh-start token
   STATE_SUBDIR=o58-scratch LADDER_FILE=out/scratch.json FRESH_START_ACK=<token> \
     scripts/ladder-run.sh ladder:once                        # builds and stores the offer
   STATE_SUBDIR=o58-scratch LADDER_FILE=out/scratch.json scripts/ladder-run.sh offers:verify
   FUNDING_WALLET_FILE_HOST=/path/to/funding-mnemonic-file STATE_SUBDIR=o58-scratch LADDER_FILE=out/scratch.json \
     scripts/ladder-run.sh offers:settle --slot T13A-01 --pay-with <wUSDC coin nonce ≥ 9.899> --dry-run
   rm -rf ~/.stagenet-offer-ladders/o58-scratch               # the scratch offer is never posted
   ```

   The dry run balances the settlement with the pinned wUSDC coin, proves and finalizes it,
   prints the fee (`feeDust`) and size (`bytes`), releases the wallet's reservation, and
   submits nothing. The same `--dry-run` works against a live offer from a copy of the live
   state (see "Runbook (books)" step 6).
6. **Switch the running service** (in its `docker compose` directory): back up `.env`, check
   out this branch, set `LADDER_FILE=ladders/stagenet.books.json` and a new `IMAGE_TAG`, keep
   `JOURNAL_FILE` and `OUTBOX_DIR` (the same journal: the 20 stock slots keep their
   definitions and their live offers, and the new slots join as `idle`, so no fresh-start
   acknowledgement is needed), then `docker compose up -d --build --timeout 150 ladder`. The
   recreated container mounts the new `makers.json`.
   - Tick 1 opens each wallet in file order: every T-bill maker builds and posts its offer
     right after its sync (about 2 min each), then the 20 stock slots reconcile as `live`
     with their same offer ids, with no build and no post.
   - Rollback before the first T-bill post: restore the `.env` backup and run the same
     `up -d` (the previous image). After it, the journal refuses a ladder file without the
     T-bill slots (their offers are outstanding), which is intended: keep
     `ladders/stagenet.books.json`.

## License

Apache-2.0 (see `LICENSE`). The token contracts are copies of the reference contracts in
`acedward/mip-0018-midnight-contracts` (Apache-2.0); each copied file names its source
commit.
