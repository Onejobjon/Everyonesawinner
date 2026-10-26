// Tests for the paid-bet (real-money) sequential-lay maths and backward-compat
// of the free-bet (SNR) engine. Run: `bun scripts/test-paid-mode.ts`.
import { sequentialLayPlan, sequentialLayPlanPaid } from "../src/lib/acca";
import { calcLay } from "../src/lib/odds";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function near(a: number, b: number, tol = 0.02) {
  return Math.abs(a - b) < tol;
}

const C = 0.05;

// 1. Symmetric qualifying loss on a tight gap: every branch equals the locked-in figure.
{
  const legs = [
    { backOdds: 2.0, layOdds: 2.1 },
    { backOdds: 1.8, layOdds: 1.9 },
  ];
  const p = sequentialLayPlanPaid(legs, 20, C)!;
  const S = 20;
  const B = 3.6;
  const [l1, l2] = p.legs;
  const netWin = S * (B - 1) - (l1.liability + l2.liability);
  const netLeg1Loses = -S + l1.layWin;
  const netLeg2Loses = -S - l1.liability + l2.layWin;
  console.log("1. Paid sequential-lay (2 legs)");
  check("locked-in is a small negative (qualifying cost)", p.retainedProfit < 0 && p.retainedProfit > -5, `got ${p.retainedProfit}`);
  check("win branch == locked-in", near(netWin, p.retainedProfit), `${netWin} vs ${p.retainedProfit}`);
  check("leg-1-loss branch == locked-in", near(netLeg1Loses, p.retainedProfit));
  check("leg-2-loss branch == locked-in", near(netLeg2Loses, p.retainedProfit));
}

// 2. Stake scaling is linear.
{
  const legs = [{ backOdds: 2.0, layOdds: 2.1 }];
  const p10 = sequentialLayPlanPaid(legs, 10, C)!;
  const p40 = sequentialLayPlanPaid(legs, 40, C)!;
  console.log("2. Stake scaling (single leg)");
  check("retainedProfit scales 4x", near(p40.retainedProfit, p10.retainedProfit * 4));
  check("lay stake scales 4x", near(p40.legs[0].layStake, p10.legs[0].layStake * 4));
}

// 3. Commission is applied.
{
  const legs = [{ backOdds: 2.0, layOdds: 2.1 }];
  const c0 = sequentialLayPlanPaid(legs, 20, 0)!;
  const c5 = sequentialLayPlanPaid(legs, 20, 0.05)!;
  console.log("3. Commission applied");
  check("higher commission → worse locked-in result", c5.retainedProfit < c0.retainedProfit, `${c0.retainedProfit} vs ${c5.retainedProfit}`);
}

// 4. Single-leg paid plan matches the existing calcLay qualifying-loss maths.
{
  const p = sequentialLayPlanPaid([{ backOdds: 2.0, layOdds: 2.1 }], 20, C)!;
  const c = calcLay(2.0, 2.1, 20, C)!;
  console.log("4. Single-leg paid == calcLay");
  check("retainedProfit == calcLay.profitLoss", near(p.retainedProfit, c.profitLoss), `${p.retainedProfit} vs ${c.profitLoss}`);
  check("lay stake == calcLay.layStake", near(p.legs[0].layStake, c.layStake));
}

// 5. Backward-compat: free-bet (SNR) engine unchanged.
{
  const f = sequentialLayPlan([{ backOdds: 2.0, layOdds: 2.1 }], 10, C)!;
  console.log("5. Free-bet (SNR) still works");
  check("retained profit positive", f.retainedProfit > 0, `${f.retainedProfit}`);
  check("retention in 0..1", f.retention > 0 && f.retention <= 1, `${f.retention}`);
}

// 6. Guards — never fabricate a lay price.
{
  console.log("6. Guards");
  check("null on missing lay odds", sequentialLayPlanPaid([{ backOdds: 2.0, layOdds: 0 }], 20, C) === null);
  check("null on back odds <= 1", sequentialLayPlanPaid([{ backOdds: 1.0, layOdds: 1.9 }], 20, C) === null);
  check("null on zero stake", sequentialLayPlanPaid([{ backOdds: 2.0, layOdds: 2.1 }], 0, C) === null);
}

console.log(failures === 0 ? "\nALL PAID-MODE TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
