# Marketing stack (#202–#216) vs `main` — campaign-code collision & resolution

**Date:** 2026-07-26
**Status:** resolved in this branch (`agent/marketing-consolidated`, PR #222).

## Summary

#216 was a content-superset of the whole marketing stack, but it did not merge cleanly onto `main`: while the stack was built, `main` shipped its **own** campaigns redesign (#214, #192) plus **tenant-isolation** hardening, both rewriting `src/app/actions/campaigns.ts` and `src/lib/campaigns.ts`. #222 consolidates the entire stack onto current `main` and resolves that collision.

## The two implementations

| | `main` (shipped) | Marketing stack `#216` |
|---|---|---|
| Send path | direct: `sendCampaign()` → `sendCampaignBatch(id, tenantId)` inside the web request | governed: draft → review → approve → queue; delivery only in `runSafeCampaignQueue()` |
| Tenant isolation | added to the direct path + shared helpers | in the governed queue (`tenantId IS NOT DISTINCT FROM`, `FOR UPDATE … SKIP LOCKED`) |
| `actions/campaigns.ts` `sendCampaign` | full direct launch | **retired** (must contain no `sendCampaignBatch(`, must say "Direct campaign launch has been retired") |

The marketing stack **intentionally retires** direct launch. `marketingGovernanceIntegration.test.ts` enforces it.

## Why "keep main's file wholesale" was wrong

The first consolidation pass resolved the conflict to main's `actions/campaigns.ts`. That reintroduced the direct sender the stack retired — and with `CampaignRecipient.status` now defaulting to `pending` (not `queued`), the legacy sender would create pending recipients, deliver zero, mark the campaign `sent`, and leave it unrecoverable by the safe cron. It also failed the governance test. **The correct action is to retire the path, not repair it.**

## Final resolution in #222

1. **`actions/campaigns.ts`** — `sendCampaign` retired (returns a message pointing to Marketing → Campaigns; no `sendCampaignBatch` import/call). **main's stronger tenant hardening is kept on every retained helper**: `saveSegment` stamps `tenantId`; `deleteSegment`/`setMarketingOptOut` scope by tenant; `criteriaFor`/`audienceLabel` resolve tags/segments within the active tenant.
2. **`lib/campaigns.ts`** — kept at main's tenant-scoped version. With the action retired and the cron running only `runSafeCampaignQueue`, its `sendCampaignBatch`/`runCampaignQueue` are no longer on the live path.
3. **`/campaigns`** — made a read-only compatibility screen: the direct-launch composer/"new" tab is removed and "Create campaign" points at `/marketing/campaigns/new`. Overview reporting and subscriber-consent management remain.
4. **Single send path** — the tenant cron runs only `runSafeCampaignQueue` / `runSafeSurveyDistributionQueue`; no double-send.

`Campaign.status` / `CampaignRecipient.status` are free-form `String`, so legacy and governed vocabularies coexist without DB constraint issues.

## Not done here
- Nothing merged to `main`.
- The intermediate PRs (#202, #207–#213, #215, #216) are **not** closed — close them once #222 is approved. See `docs/marketing-platform-rollout.md`.
