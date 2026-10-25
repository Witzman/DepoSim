// A check at build time, nothing at run time: what the server sends must fit the types the page was written against.
// The page keeps its own copy of the types (it must not import server code); this file is where the two are held side by side,
// so that `npm run typecheck` fails when the server changes a shape and the copy does not follow.
import type * as Server from "../../server/src/session.js";
import type * as Web from "./types.js";

type Fits<From, To> = From extends To ? true : false;
const ok = <T extends true>(): T => true as T;

export const contract = {
  snapshot: ok<Fits<Server.Snapshot, Web.Snapshot>>(),
  evaluation: ok<Fits<Server.Evaluation, Web.Evaluation>>(),
  curves: ok<Fits<Server.Curves, Web.Curves>>(),
  rolling: ok<Fits<Server.RollingResult, Web.RollingResult>>(),
  taxReport: ok<Fits<Server.TaxReport, Web.TaxReport>>(),
  runSummary: ok<Fits<Server.RunSummary, Web.RunSummary>>(),
  hints: ok<Fits<Server.HintsResult, Web.HintsResult>>(),
  comparison: ok<Fits<Server.Comparison, Web.CompareResult["simulations"][number]>>(),
  scenarioResult: ok<Fits<Server.ScenarioResult, Web.ScenarioResult>>(),
};
