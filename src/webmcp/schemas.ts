/**
 * Schema builders bound to live page state.
 *
 * This is the mechanism the whole project is built around, so it is worth
 * being precise about what it buys.
 *
 * A conventional MCP server publishes its manifest when the client connects.
 * By the time anyone knows which dataset is loaded, the schema is fixed, so a
 * column argument has to be a free-text string, and an agent that writes
 * "close_price" instead of "close" gets an error and burns a turn - or worse,
 * gets a plausible-looking result from a column it did not mean.
 *
 * Because registerTool can be called at any time, we do the opposite. When a
 * dataset loads we tear the analysis tools down and register them again with
 * that dataset's actual column names inside the `enum` of their inputSchema.
 * An invalid column stops being an error the agent has to recover from and
 * becomes something it cannot express: the schema it was handed does not
 * contain the word. Add a derived column with add_feature and the enums grow
 * to include it, immediately, without the agent doing anything.
 *
 * A static manifest cannot do this. That is the answer to "why does this need
 * WebMCP rather than an MCP server".
 */

import { DATASET_IDS, DATASETS } from "../config";
import { TRANSFORM_KINDS } from "../engine/features";
import type { JsonSchema } from "./host";

function enumOf(values: string[], description: string): Record<string, unknown> {
  return { type: "string", enum: values, description };
}

export const EMPTY_SCHEMA: JsonSchema = { type: "object", properties: {} };

export function loadDatasetSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      dataset_id: enumOf(
        DATASET_IDS,
        `Which bundled dataset to load. ${DATASETS.map((d) => `${d.id}: ${d.domain}`).join("; ")}.`,
      ),
      start: {
        type: "string",
        description:
          "Optional ISO date (YYYY-MM-DD) for the start of the sample window. The human can change this later and your next call will see the change.",
      },
      end: {
        type: "string",
        description: "Optional ISO date (YYYY-MM-DD) for the end of the sample window.",
      },
    },
    required: ["dataset_id"],
  };
}

export function describeDatasetSchema(columns: string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      columns: {
        type: "array",
        items: enumOf(columns, "Column name."),
        description: "Optional subset of columns to describe. Omit for all of them.",
      },
    },
  };
}

export function addFeatureSchema(numericColumns: string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      transform: enumOf(
        [...TRANSFORM_KINDS],
        "The transform to apply. momentum is the standard 12-1 construction: trailing return to 21 days ago. zscore is cross-sectional within each date, not a time-series z-score. forward_return is the only forward-looking transform and is legal only as a regression dependent variable.",
      ),
      source_column: enumOf(numericColumns, "Column to transform."),
      window: {
        type: "integer",
        minimum: 2,
        maximum: 2520,
        description:
          "Lookback in trading days. Used by momentum (try 252), realised_vol (try 21) and lag (try 1).",
      },
      horizon: {
        type: "integer",
        minimum: 1,
        maximum: 252,
        description: "Forward horizon in trading days. Used by forward_return only.",
      },
      name: {
        type: "string",
        description: "Optional name for the new column. A sensible one is derived if omitted.",
      },
    },
    required: ["transform", "source_column"],
  };
}

export function summaryStatsSchema(numericColumns: string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      columns: {
        type: "array",
        items: enumOf(numericColumns, "Column name."),
        minItems: 1,
        description: "Columns to summarise.",
      },
    },
    required: ["columns"],
  };
}

export function correlateSchema(numericColumns: string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      columns: {
        type: "array",
        items: enumOf(numericColumns, "Column name."),
        minItems: 2,
        description: "Two or more columns. With exactly two you get a pair, with more a matrix.",
      },
      method: enumOf(
        ["pearson", "spearman"],
        "pearson for linear association, spearman for monotonic association that is robust to outliers.",
      ),
    },
    required: ["columns"],
  };
}

export function runRegressionSchema(
  dependents: string[],
  regressors: string[],
): JsonSchema {
  return {
    type: "object",
    properties: {
      dependent: enumOf(dependents, "The variable being explained."),
      independent: {
        type: "array",
        items: enumOf(regressors, "Regressor column."),
        minItems: 1,
        description:
          "Regressors. Forward-looking columns are absent from this list on purpose: they cannot be predictors.",
      },
      standard_errors: enumOf(
        ["newey_west", "classical"],
        "newey_west by default. Use classical only when you have a positive reason to believe the residuals are independent.",
      ),
      newey_west_lags: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description:
          "Bandwidth for the HAC estimator. Defaults to floor(4*(n/100)^(2/9)), which is the standard rule.",
      },
    },
    required: ["dependent", "independent"],
  };
}

export function hypothesisTestSchema(
  numericColumns: string[],
  categoryColumns: string[],
  categoryLabels: string[],
): JsonSchema {
  const hasCategories = categoryColumns.length > 0;

  const properties: Record<string, unknown> = {
    test: enumOf(
      [
        "one_sample_t",
        "two_sample_t",
        "paired_t",
        "jarque_bera",
        ...(hasCategories ? ["anova"] : []),
        ...(categoryColumns.length >= 2 ? ["chi_square"] : []),
      ],
      "one_sample_t: is the mean of a column different from a value. two_sample_t: do two groups or two columns have different means (Welch, unequal variances). anova: does a measurement differ across ALL groups of a category at once - prefer this over repeated two_sample_t calls, which inflate the error rate. chi_square: are two categorical columns independent. paired_t: is the mean difference between two aligned columns zero. jarque_bera: is a column normally distributed.",
    ),
    column: enumOf(
      numericColumns,
      "The measurement under test. Required by every test except chi_square, which compares two categorical columns and needs no measurement.",
    ),
    other_column: enumOf(
      numericColumns,
      "The second column. Use for paired_t, or for a two_sample_t that compares two different measurements rather than two groups.",
    ),
    mu: {
      type: "number",
      description: "Null-hypothesis mean for one_sample_t. Defaults to 0.",
    },
  };

  // Only offered when the loaded dataset actually has something to group by.
  if (hasCategories) {
    properties.group_column = enumOf(
      categoryColumns,
      "The categorical column to group by. With two_sample_t it splits `column` between group_a and group_b; with anova it compares every group at once; with chi_square it is the first of the two factors.",
    );
    properties.group_a = enumOf(
      categoryLabels,
      "The first group, a value from group_column. two_sample_t only.",
    );
    properties.group_b = enumOf(
      categoryLabels,
      "The second group, a value from group_column. two_sample_t only.",
    );
  }

  if (categoryColumns.length >= 2) {
    properties.second_group_column = enumOf(
      categoryColumns,
      "The second factor, for chi_square. Must differ from group_column.",
    );
  }

  // `column` is not universally required: chi_square has no measurement. Each
  // test validates what it needs and says so if it is missing.
  return { type: "object", properties, required: ["test"] };
}

export function runBacktestSchema(signalColumns: string[]): JsonSchema {
  return {
    type: "object",
    properties: {
      signal_column: enumOf(
        signalColumns,
        "The column to sort the cross-section on. Only derived, causal columns appear here: raw data columns and forward-looking columns are excluded because neither can be a tradeable signal.",
      ),
      holding_days: {
        type: "integer",
        minimum: 1,
        maximum: 252,
        description: "Trading days between rebalances. 21 is monthly.",
      },
      n_quantiles: {
        type: "integer",
        minimum: 2,
        maximum: 10,
        description: "Number of buckets to sort into. Long the top, short the bottom. Default 5.",
      },
      cost_bps: {
        type: "number",
        minimum: 0,
        maximum: 200,
        description: "Round-trip transaction cost in basis points, charged on turnover. Default 5.",
      },
    },
    required: ["signal_column", "holding_days"],
  };
}

export function bootstrapStrategySchema(maxSimulations: number): JsonSchema {
  return {
    type: "object",
    properties: {
      n_simulations: {
        type: "integer",
        minimum: 100,
        maximum: maxSimulations,
        description: `How many resampled paths to draw. Above 2000 this asks the human for approval before it runs.`,
      },
      block_length_days: {
        type: "integer",
        minimum: 1,
        maximum: 252,
        description:
          "Mean block length. Blocks preserve autocorrelation; 21 (one month) is a reasonable default. A block length of 1 is an iid bootstrap and will understate the uncertainty.",
      },
    },
    required: ["n_simulations"],
  };
}

export function setHypothesisSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      hypothesis: {
        type: "string",
        maxLength: 500,
        description:
          "The question in one or two sentences, stated so that it could be wrong. The human can edit this at any time and you will see their version on your next call.",
      },
    },
    required: ["hypothesis"],
  };
}

export function recordFindingSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      finding: {
        type: "string",
        maxLength: 500,
        description: "What you concluded, in one or two sentences.",
      },
      supporting_steps: {
        type: "array",
        items: { type: "integer", minimum: 1 },
        minItems: 1,
        description:
          "Run-log step numbers that produced this. Every finding must cite at least one step that actually ran; get_state lists them.",
      },
    },
    required: ["finding", "supporting_steps"],
  };
}

export function buildReportSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      conclusion: {
        type: "string",
        maxLength: 1000,
        description: "Your overall conclusion. The rest of the report is assembled from the run log.",
      },
    },
    required: ["conclusion"],
  };
}
