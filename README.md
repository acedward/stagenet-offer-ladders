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
6. **Run** (from the repository directory):
   - `cp .env.example .env`, then edit it: `LADDER_FILE`, `LADDER_MEM_LIMIT` (2g is enough
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
| `wallets:addresses` / `wallets:check` | write / verify the public addresses file |
| `makers:status [--slots …]` | sync makers one at a time; NIGHT, DUST, shielded balances |
| `makers:register-dust [--slots …]` | register NIGHT for DUST generation |
| `makers:mint [--slots …] [--inventory-offers 10]` | self-mint the inventory coin (00053 grid ladders) |
| `makers:fund --ladder-file … [--dry-run] [--batch-size 5] [--check-balances]` | send each book maker its inventory from the funding wallet (00057) |
| `ladder:once` / `ladder:run` | one reconcile tick / the service loop (SIGTERM stops after the current slot) |
| `offers:verify` | decode the current offers and check them against the journal and the grid |
| `offers:inspect --offer-id …` | decode one stored offer |
| `offers:settle --slot AB-02 --pay-with <nonce>` | test taker: settle a stored offer with the funding wallet, paying with a pinned coin |
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
3. **Still to do: kernel mode.** Before relying on kernel mode unattended, run one real post
   against the stagenet kernel (or FR-006's local devnet + kernel end-to-end) and watch
   `/status` go `submitted` → `live`. Then set `ZSWAP_API` and restart: the stored offers
   are published as they are (no rebuild).

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
  - A colour that starts with `PENDING` is refused with a "fill it in" error. That is how the
    wUSDC colour waits for AA 00037's record.

### Canonical addresses

| What | Value |
|---|---|
| wStkA colour (bridged stkA) | `5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02` |
| wStkB colour (bridged stkB) | `e7ca18cb056477a5aca5cce387306d56526c2f226b4a4e34f068e3a3e8179588` |
| wUSDC colour (bridged Circle USDC) | from AA 00037 P7's record, `deployments/stagenet-vault.json` in [acedward/passport PR #4](https://github.com/acedward/passport/pull/4); pending in this file until recorded |
| Bridge vault (Midnight stagenet, AA 00037) | `7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637` |
| Vault's EVM account (Sepolia, chain 11155111) | `0x648216975e722494bFF92E88FFc68C8F8d438FaA` |
| stkA ERC20 (Sepolia, 6 decimals) | `0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52` |
| stkB ERC20 (Sepolia, 6 decimals) | `0xF2bEFf36543219C8feC2AB2f42070AA65D3C844B` |
| Circle USDC (Sepolia, 6 decimals) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Native stkA / stkB / stkC (00052) | contracts and colours in the table at the top (`deployments/stagenet.json`) |
| Maker public addresses | `ladders/makers.stagenet.public.json` (20 wallets AB-01…10, BC-01…10) |

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

1. **wUSDC colour.** Once AA 00037 has recorded wUSDC, put its colour into
   `tokens.wUSDC.colour` and run `bun test test/book.test.ts`. The file is refused if the colour
   is not the vault's colour for Circle USDC.
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

## License

Apache-2.0 (see `LICENSE`). The token contracts are copies of the reference contracts in
`acedward/mip-0018-midnight-contracts` (Apache-2.0); each copied file names its source
commit.
