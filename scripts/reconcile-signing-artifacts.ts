import { withSystemScope } from "../src/lib/tenantScope";
import { reconcileCompletedEnvelopes, collectSettledOrphans, collectUnregisteredUploadIntents } from "../src/lib/signing/reconcile";

async function main() {
  const limit = Math.max(1, Math.min(Number(process.argv[2] || 500), 5_000));
  const result = await withSystemScope(async () => ({
    reconciliation: await reconcileCompletedEnvelopes(limit),
    orphanSettlement: await collectSettledOrphans(limit),
    uploadIntentSettlement: await collectUnregisteredUploadIntents(limit),
  }));
  console.log(JSON.stringify(result, null, 2));
  if (result.reconciliation.failed) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
