import { z } from "zod";

/*
 * Zod v4 probes `Function("")` the first time it builds an object schema, to
 * decide whether it may compile a faster parser. Our CSP forbids eval, so the
 * probe is refused and Zod falls back — but the browser still files a
 * `script-src blocked eval` violation from our own bundle on every page load
 * (/login, the dashboard), which buries real reports in the System Log.
 *
 * `jitless` skips the probe entirely. This file runs before the app's own code,
 * so it is set before any schema exists.
 */
z.config({ jitless: true });
