import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * ?tpl= on the quote print route renders a builder template's UNPUBLISHED draft
 * (quotePrintDocument uses getBuilderTemplate for it). Quote read access alone
 * let any quote reader see work-in-progress layouts; it now needs Builder access,
 * and anyone else gets the quote exactly as customers do.
 */
const route = readFileSync("src/app/(print)/quotes/[id]/print/route.ts", "utf8");

test("?tpl= is honoured only for docbuilder.view/manage", () => {
  assert.match(route, /const user = await requireQuoteReadAccess\(id\)/);
  assert.match(
    route,
    /const templateId = requested && \(await hasAnyPermission\(user, "docbuilder\.view", "docbuilder\.manage"\)\) \? requested : null/,
  );
  // The raw parameter never reaches the renderer.
  assert.doesNotMatch(route, /templateId = new URL\(request\.url\)\.searchParams\.get\("tpl"\)/);
});
