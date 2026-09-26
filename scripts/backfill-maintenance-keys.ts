/**
 * Audit C10: backfill `maintenanceVerifyingKey` in deployments/stagenet.json from the
 * chain (public data only): each contract's on-chain maintenance-authority committee.
 * Reads no secret and submits nothing.
 *
 *   bun scripts/backfill-maintenance-keys.ts [--write]
 */
import { readFileSync, writeFileSync } from "node:fs";

import { publicDataProviderFor } from "../src/providers.ts";
import { DEPLOYMENT_FILE } from "../src/tokens.ts";
import { stagenet } from "../src/wallet.ts";

const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as {
  tokens: Record<string, { address?: string; maintenanceVerifyingKey?: unknown }>;
};
const publicData = publicDataProviderFor(stagenet());
const out: Record<string, unknown> = {};
for (const [id, record] of Object.entries(deployment.tokens)) {
  if (!record.address) continue;
  const state = await publicData.queryContractState(record.address);
  if (!state) throw new Error(`${id}: no contract state at ${record.address}`);
  const authority = (state as unknown as { maintenanceAuthority: { committee: { tag: string; value: string }[]; threshold: number } })
    .maintenanceAuthority;
  if (authority.committee.length !== 1) throw new Error(`${id}: expected a 1-key committee, got ${authority.committee.length}`);
  const key = authority.committee[0]!;
  out[id] = { before: record.maintenanceVerifyingKey, after: `${key.tag}:${key.value}`, threshold: authority.threshold };
  record.maintenanceVerifyingKey = `${key.tag}:${key.value}`;
}
console.log(JSON.stringify(out, null, 2));
if (process.argv.includes("--write")) writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(deployment, null, 2)}\n`);
process.exit(0);
