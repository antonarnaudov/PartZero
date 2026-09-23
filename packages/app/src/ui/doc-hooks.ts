import { useMemo } from "react";
import { collectProblems, type Problem } from "../doc/problems";
import { buildTimeline, type TimelineModel } from "../doc/timeline";
import { useApp, useStore } from "./context";

/** The current problem list (recomputed only when compile/report/engine error change). */
export function useProblems(): Problem[] {
  const { services } = useApp();
  const compile = useStore(services.doc, (s) => s.compile);
  const model = useStore(services.doc, (s) => s.model);
  const report = useStore(services.doc, (s) => s.report);
  const engineError = useStore(services.doc, (s) => s.engineError);
  return useMemo(() => collectProblems({ compile, model, report, engineError }), [compile, model, report, engineError]);
}

export function useTimeline(problems: readonly Problem[]): TimelineModel {
  const { services } = useApp();
  const compile = useStore(services.doc, (s) => s.compile);
  const model = useStore(services.doc, (s) => s.model);
  const report = useStore(services.doc, (s) => s.report);
  return useMemo(() => buildTimeline({ compile, model, report }, problems), [compile, model, report, problems]);
}
