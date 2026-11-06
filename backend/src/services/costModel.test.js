'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_PARAMS,
  actionCost,
  actionCostCurve,
  estimateRates,
  ledgerRate,
  ledgerGrowthRate,
  hybridRequestRate,
  computeCostSummary,
} = require('./costModel');

test('actionCost matches the paper formula Ce + Cv + Co/b', () => {
  // Section 3.5.2, default params: Ce=12, Cv=6, Co=40.
  assert.equal(actionCost(DEFAULT_PARAMS, 1), 12 + 6 + 40 / 1);
  assert.equal(actionCost(DEFAULT_PARAMS, 10), 12 + 6 + 40 / 10);
  assert.equal(actionCost(DEFAULT_PARAMS, 40), 12 + 6 + 40 / 40);
});

test('actionCost treats batch size <= 0 as 1 (never divides by zero)', () => {
  const atZero = actionCost(DEFAULT_PARAMS, 0);
  const atOne = actionCost(DEFAULT_PARAMS, 1);
  assert.equal(atZero, atOne);
});

test('actionCost is strictly decreasing in batch size, asymptoting to Ce + Cv', () => {
  const costs = [1, 2, 5, 10, 25, 50].map((b) => actionCost(DEFAULT_PARAMS, b));
  for (let i = 1; i < costs.length; i++) {
    assert.ok(costs[i] < costs[i - 1], `expected cost to decrease from b=${[1, 2, 5, 10, 25, 50][i - 1]} to b=${[1, 2, 5, 10, 25, 50][i]}`);
  }
  const floor = DEFAULT_PARAMS.Ce + DEFAULT_PARAMS.Cv;
  assert.ok(costs[costs.length - 1] > floor, 'cost at a large batch size should still sit above the Ce+Cv floor');
  assert.ok(costs[costs.length - 1] - floor < 1, 'cost at a large batch size should be within 1ms of the Ce+Cv floor');
});

test('actionCostCurve sweeps 1..maxBatch and matches actionCost at each point', () => {
  const curve = actionCostCurve(DEFAULT_PARAMS, 5);
  assert.equal(curve.length, 5);
  assert.deepEqual(curve.map((p) => p.b), [1, 2, 3, 4, 5]);
  for (const point of curve) {
    assert.equal(point.cost, Number(actionCost(DEFAULT_PARAMS, point.b).toFixed(3)));
  }
});

test('estimateRates divides lifetime counters by the elapsed window', () => {
  const rates = estimateRates({ reference: 100, grant: 50, audit: 25 }, 10);
  assert.equal(rates.lambda_r, 10);
  assert.equal(rates.lambda_g, 5);
  assert.equal(rates.lambda_a, 2.5);
});

test('estimateRates floors the window at 1 second to avoid a divide-by-zero spike', () => {
  const rates = estimateRates({ reference: 10, grant: 0, audit: 0 }, 0);
  assert.equal(rates.lambda_r, 10);
});

test('ledgerRate combines the three event rates through actionCost at the configured batch size', () => {
  const rates = { lambda_r: 1, lambda_g: 1, lambda_a: 1 };
  const expected = 3 * actionCost(DEFAULT_PARAMS, DEFAULT_PARAMS.b);
  assert.equal(ledgerRate(rates, DEFAULT_PARAMS), Number(expected.toFixed(3)));
});

test('ledgerGrowthRate compares reference-only growth against a full-record-on-chain baseline', () => {
  const rates = { lambda_r: 1, lambda_g: 0, lambda_a: 0 };
  const result = ledgerGrowthRate(rates);
  // Only reference events flowing: bytesPerSecond is just sP.
  assert.equal(result.bytesPerSecond, 220);
  // The baseline additionally counts a full FHIR bundle per reference event.
  assert.equal(result.baselineBytesPerSecondIfFullRecordOnChain, 220 + 45000);
  assert.ok(result.reductionFactor > 1, 'writing references instead of full records should reduce ledger growth');
});

test('ledgerGrowthRate reductionFactor grows as the on-chain footprint shrinks relative to the baseline', () => {
  const smallFootprint = ledgerGrowthRate({ lambda_r: 1, lambda_g: 0, lambda_a: 0 }, { sP: 100, sG: 260, sA: 240, sR: 45000 });
  const largeFootprint = ledgerGrowthRate({ lambda_r: 1, lambda_g: 0, lambda_a: 0 }, { sP: 10000, sG: 260, sA: 240, sR: 45000 });
  assert.ok(smallFootprint.reductionFactor > largeFootprint.reductionFactor);
});

test('hybridRequestRate adds the offline-retry contribution to the event-driven rate', () => {
  const q = hybridRequestRate({ lambdaEvent: 2, offlineFraction: 0.3, retryIntervalSeconds: 30 });
  assert.equal(q, 2 + 0.3 / 30);
});

test('hybridRequestRate defaults the retry interval to 30 seconds per Section 3.6', () => {
  const withDefault = hybridRequestRate({ lambdaEvent: 1, offlineFraction: 3 });
  const explicit = hybridRequestRate({ lambdaEvent: 1, offlineFraction: 3, retryIntervalSeconds: 30 });
  assert.equal(withDefault, explicit);
});

test('computeCostSummary merges caller params over the defaults and bundles every quantity', () => {
  const summary = computeCostSummary({
    counters: { reference: 10, grant: 5, audit: 5 },
    windowSeconds: 10,
    params: { b: 20 },
  });

  assert.equal(summary.params.b, 20, 'caller-supplied b should override the default');
  assert.equal(summary.params.Ce, DEFAULT_PARAMS.Ce, 'unspecified params should fall back to defaults');
  assert.equal(summary.counters.reference, 10);
  assert.equal(summary.rates.lambda_r, 1);
  assert.equal(summary.actionCostAtCurrentBatch, Number(actionCost({ ...DEFAULT_PARAMS, b: 20 }, 20).toFixed(3)));
  assert.ok(Array.isArray(summary.actionCostCurve));
  assert.ok(typeof summary.ledgerRate === 'number');
  assert.ok(typeof summary.ledgerGrowth.bytesPerSecond === 'number');
});
