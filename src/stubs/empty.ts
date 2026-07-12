// Empty browser stub. pdfme → @pdfme/converter → clawpdf/pdfium references
// Node's `module` builtin inside a `if (ENVIRONMENT_IS_NODE)` guard that never
// runs in the browser; Turbopack still tries to resolve the specifier, so we
// alias it to this no-op for the browser target only (see next.config.ts).
export {};
