// Crash-test child: mutates the journal as fast as it can until it is SIGKILLed.
import { openJournal } from "../../src/journal.ts";

const file = process.argv[2]!;
const colour = "a".repeat(64);
const want = "b".repeat(64);
const journal = openJournal({ file, networkId: "stagenet", mode: "single-wallet-pinned" });
for (const slot of ["AB-01", "AB-02", "AB-03"]) {
  journal.ensureSlot({ slot, ladder: "AB", level: 0, walletId: "funding", giveColour: colour, wantColour: want, giveAmount: "100", wantAmount: "80", price: "0.800" });
}
process.stdout.write("ready\n");
for (let n = 0; ; n++) {
  for (const slot of ["AB-01", "AB-02", "AB-03"]) {
    const nonce = (n % 16).toString(16).repeat(64);
    const record = journal.get(slot)!;
    if (record.state === "posting" || record.state === "live") {
      journal.endOffer(slot, "expired");
      continue;
    }
    journal.beginOffer(slot, {
      offerId: `${slot === "AB-01" ? "1" : slot === "AB-02" ? "2" : "3"}${(n % 16).toString(16).repeat(63)}`,
      blobSha256: "c".repeat(64),
      delivery: "outbox",
      coinNonce: `${slot.slice(-1)}${nonce.slice(1)}`,
      coinNullifier: "d".repeat(64),
      coinValue: "100",
      giveAmount: "100",
      wantAmount: "80",
      ttlSec: 3600,
      builtAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    journal.markLive(slot);
  }
}
