/**
 * Assembles the tool set for the current state.
 *
 * Called by the registry every time the tool signature changes. Two things are
 * happening in this function and both matter:
 *
 *   - which tools exist (availability)
 *   - what is inside their schemas (the column lists, read live)
 *
 * The second is the part a static MCP manifest cannot do. `run_regression` is
 * not a tool with a `dependent: string` argument; it is a tool whose
 * `dependent` argument is an enum of the columns that exist right now, rebuilt
 * every time that set changes.
 */

import {
  dependentCandidates,
  regressorCandidateNames,
  signalColumnNames,
  useWorkspace,
} from "../../state/workspace";
import { availability } from "../availability";
import type { ToolDescriptor } from "../host";
import {
  correlateTool,
  hypothesisTestTool,
  runRegressionTool,
  summaryStatsTool,
} from "./analysis";
import { addFeatureTool } from "./features";
import { buildReportTool, recordFindingTool, setHypothesisTool } from "./report";
import {
  describeDatasetTool,
  getStateTool,
  listDatasetsTool,
  loadDatasetTool,
} from "./session";
import { bootstrapStrategyTool, runBacktestTool } from "./strategy";

export function buildToolSet(): ToolDescriptor[] {
  const surface = availability();
  const tools: ToolDescriptor[] = [
    listDatasetsTool(),
    getStateTool(),
    loadDatasetTool(),
    setHypothesisTool(),
  ];

  if (!surface.hasDataset) return tools;

  const frame = useWorkspace.getState().frame;
  const allColumns = frame?.columnOrder ?? [];
  const numeric = allColumns.filter((n) => frame?.columns[n].kind === "numeric");
  const dependents = dependentCandidates();
  const regressors = regressorCandidateNames();

  tools.push(
    describeDatasetTool(allColumns),
    addFeatureTool(numeric),
    summaryStatsTool(numeric),
    correlateTool(numeric),
    runRegressionTool(dependents, regressors),
    hypothesisTestTool(numeric),
    recordFindingTool(),
    buildReportTool(),
  );

  if (surface.hasSignal) tools.push(runBacktestTool(signalColumnNames()));
  if (surface.hasBacktest) tools.push(bootstrapStrategyTool());

  return tools;
}
