/**
 * QUICK ADD (Node-RED's Ctrl+click quick-add; Sean, 2026-11-04): Ctrl+click empty canvas, type "mess", Enter — a
 * Message step lands where you clicked. Ranks the builder's step types: a label that STARTS with what was typed
 * first, then one that contains it, then a description that does.
 */
export type StepTypeOption<T extends string = string> = { type: T; label: string; description: string };

export function rankStepTypes<T extends string>(query: string, options: StepTypeOption<T>[], limit = 7): StepTypeOption<T>[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return options.slice(0, limit);
  const score = (o: StepTypeOption<T>) => {
    const label = o.label.toLocaleLowerCase();
    if (label.startsWith(q) || o.type.toLocaleLowerCase().startsWith(q)) return 0;
    if (label.includes(q)) return 1;
    if (o.description.toLocaleLowerCase().includes(q)) return 2;
    return 3;
  };
  return options
    .map((o, i) => ({ o, s: score(o), i }))
    .filter((x) => x.s < 3)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.o);
}
