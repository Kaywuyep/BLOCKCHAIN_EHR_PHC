'use strict';

/**
 * costModel.js
 *
 * Implements the transaction-optimisation cost model from Section 3.5.2
 * of the seminar paper, over the raw event counters returned by the
 * chaincode's CostMetricsContract (or the simulator's equivalent).
 *
 * This module intentionally keeps every formula name aligned with the
 * paper's notation (k, Ce, Co, Cv, lambda_r, lambda_g, lambda_a, b) so a
 * reader can hold the paper and this file side by side.
 */

/**
 * @typedef {Object} CostParams
 * @property {number} k    Required endorsing organisations/peers
 * @property {number} Ce   Per-transaction endorsement cost (ms, illustrative unit)
 * @property {number} Co   Fixed ordering/block-processing overhead (ms)
 * @property {number} Cv   Per-transaction validation/commit cost (ms)
 * @property {number} b    Transactions per cut block (batch size)
 */

const DEFAULT_PARAMS = {
  k: 2, // both hospital orgs must endorse, per the AccessControl endorsement policy
  Ce: 12, // illustrative ms; replace with Hyperledger Caliper benchmarking results (Section 3.12)
  Co: 40,
  Cv: 6,
  b: 10,
};

/**
 * Caction(b) = Ce + Cv + Co/b   -- per-action processing cost at batch size b.
 * Strictly decreasing in b, asymptoting at Ce + Cv (Section 3.5.2).
 */
function actionCost(params, b) {
  const batch = Math.max(1, b);
  return params.Ce + params.Cv + params.Co / batch;
}

/**
 * Sweep of Caction(b) over a batch-size range, for the diminishing-returns
 * chart in the demo (Section 3.5.2: "diminishing returns past a moderate
 * batch size rather than unlimited benefit from batching further").
 */
function actionCostCurve(params, maxBatch = 50) {
  const points = [];
  for (let b = 1; b <= maxBatch; b++) {
    points.push({ b, cost: Number(actionCost(params, b).toFixed(3)) });
  }
  return points;
}

/**
 * Ledger_rate ~= (lambda_r + lambda_g + lambda_a) * Caction(b)
 * Rates are derived here from raw lifetime counters and an elapsed-time
 * window, giving events/unit-time -- a live approximation rather than an
 * assumed constant, consistent with "The model defines falsifiable
 * relationships rather than assumed numerical values" (Section 3.5.2).
 */
function estimateRates(counters, windowSeconds) {
  const w = Math.max(1, windowSeconds);
  return {
    lambda_r: counters.reference / w,
    lambda_g: counters.grant / w,
    lambda_a: counters.audit / w,
  };
}

function ledgerRate(rates, params) {
  const combined = rates.lambda_r + rates.lambda_g + rates.lambda_a;
  return combined * actionCost(params, params.b);
}

/**
 * dG/dt = lambda_r*sP + lambda_g*sG + lambda_a*sA  -- ledger growth rate.
 * Sizes are measured, not assumed; sensible bytes-based defaults are
 * supplied here and should be replaced with real measurements once the
 * ledger schema is implemented (Section 3.5.2: "Sizes... measured from
 * the implemented ledger schema").
 */
const DEFAULT_RECORD_SIZES = {
  sP: 220, // RecordReference JSON, bytes
  sG: 260, // AccessGrant JSON, bytes
  sA: 240, // AuditEntry JSON, bytes
  sR: 45000, // illustrative FHIR R4 bundle size for comparison only -- never written on-chain
};

function ledgerGrowthRate(rates, sizes = DEFAULT_RECORD_SIZES) {
  const bytesPerSecond =
    rates.lambda_r * sizes.sP + rates.lambda_g * sizes.sG + rates.lambda_a * sizes.sA;
  const baselineBytesPerSecond = bytesPerSecond + rates.lambda_r * sizes.sR;
  return {
    bytesPerSecond: Number(bytesPerSecond.toFixed(2)),
    baselineBytesPerSecondIfFullRecordOnChain: Number(baselineBytesPerSecond.toFixed(2)),
    reductionFactor:
      baselineBytesPerSecond > 0
        ? Number((baselineBytesPerSecond / Math.max(bytesPerSecond, 1e-9)).toFixed(1))
        : null,
  };
}

/**
 * Q = lambda_event + d_offline / i  -- hybrid request rate under the
 * event-driven + offline-retry design (Section 3.5.2).
 */
function hybridRequestRate({ lambdaEvent, offlineFraction, retryIntervalSeconds = 30 }) {
  return lambdaEvent + offlineFraction / retryIntervalSeconds;
}

/**
 * Full cost-model summary bundling every quantity the frontend's
 * transaction-optimisation dashboard needs in one call.
 */
function computeCostSummary({ counters, windowSeconds, params = DEFAULT_PARAMS, sizes = DEFAULT_RECORD_SIZES }) {
  const mergedParams = { ...DEFAULT_PARAMS, ...params };
  const rates = estimateRates(counters, windowSeconds);
  return {
    params: mergedParams,
    counters,
    rates,
    actionCostAtCurrentBatch: Number(actionCost(mergedParams, mergedParams.b).toFixed(3)),
    actionCostCurve: actionCostCurve(mergedParams),
    ledgerRate: Number(ledgerRate(rates, mergedParams).toFixed(3)),
    ledgerGrowth: ledgerGrowthRate(rates, sizes),
  };
}

module.exports = {
  DEFAULT_PARAMS,
  DEFAULT_RECORD_SIZES,
  actionCost,
  actionCostCurve,
  estimateRates,
  ledgerRate,
  ledgerGrowthRate,
  hybridRequestRate,
  computeCostSummary,
};
