import test from "node:test";
import assert from "node:assert/strict";
import { explainAudience, type AudienceGroup } from "../src/lib/marketingAudiences";

test("explains nested include and exclusion groups", () => {
  const tree: AudienceGroup = {
    operator: "AND",
    rules: [
      { field: "province", operator: "equals", value: "Western Cape" },
      { operator: "OR", rules: [
        { field: "vehicle_model", operator: "in", value: ["Rover XL", "Nomad XL"] },
        { field: "product_interest", operator: "equals", value: "product-1" },
      ] },
    ],
    exclusions: [{ field: "email_available", operator: "equals", value: false }],
  };
  const result = explainAudience(tree);
  assert.match(result, /province equals Western Cape/);
  assert.match(result, /vehicle model in Rover XL,Nomad XL OR product interest equals product-1/);
  assert.match(result, /excluding email available equals false/);
});
