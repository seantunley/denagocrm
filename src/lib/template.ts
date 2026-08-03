/**
 * The `{{name}}` substitution every outbound message in the app already used.
 *
 * Lifted out of `email.ts` — unchanged, and still re-exported from there so no
 * caller moved — because `email.ts` pulls in nodemailer, the settings resolver
 * and the tenant scope. The journey `variables` step renders templates too, and
 * it is a pure decision that has to stay importable without dragging the mail
 * provider along, for the same reason journeyStepControl.ts exists.
 *
 * `\w` deliberately excludes the dot, so a template can only name a FLAT key.
 * That is why journey variables are published to templates as `var_<name>`
 * rather than `vars.<name>`: a dotted spelling would silently render empty.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
}
