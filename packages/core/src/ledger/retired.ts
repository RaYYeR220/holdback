import { reduce } from "./reduce.js";
import type { LedgerEvent } from "./types.js";

/** A test Kane's evolve retired: still sealed (Holdback never deletes Kane's files), never run again. */
export type RetiredTest = { id: string; uc: string; title?: string; file?: string };

/**
 * The tests an evolve retired (R40) that no criterion runs any more, by id: their files stay in the
 * verifier and in the seal, unchanged, and `status` and the dashboard list them as retired. Pure.
 */
export function retiredTests(events: LedgerEvent[]): RetiredTest[] {
  const live = new Set(Object.values(reduce(events).acs).flatMap((a) => a.tests));
  const known = new Map<string, { title: string; file: string }>();
  for (const e of events) if (e.t === "design") for (const t of e.tests) known.set(t.id, { title: t.title, file: t.file });
  const out = new Map<string, RetiredTest>();
  for (const e of events) {
    if (e.t !== "falsify.evolved") continue;
    for (const id of e.retired) {
      if (live.has(id)) continue;
      const k = known.get(id);
      out.set(id, { id, uc: e.uc, ...(k?.title ? { title: k.title } : {}), ...(k?.file ? { file: k.file } : {}) });
    }
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
