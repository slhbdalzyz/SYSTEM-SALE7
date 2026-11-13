/**
 * Shares a carcass's cost among its cuts by what each cut sells for (weight × price per kg), so a
 * kilo of fillet carries more of the cost than a kilo of bones. Whole dirhams that add up exactly
 * to the cost; cuts with no price yet share by weight.
 */
export function allocateCost(costMinor: number, cuts: { qtyMilli: number; priceMinor: number }[]): number[] {
  if (!cuts.length) return [];
  const byValue = cuts.every((c) => c.priceMinor > 0);
  const weights = cuts.map((c) => (byValue ? c.qtyMilli * c.priceMinor : c.qtyMilli));
  const total = weights.reduce((a, w) => a + w, 0);
  if (total <= 0) return cuts.map(() => 0);
  const raw = weights.map((w) => (costMinor * w) / total);
  const out = raw.map(Math.floor);
  let left = costMinor - out.reduce((a, x) => a + x, 0);
  // The dirhams lost to rounding go to the cuts that lost the most.
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

/** The share of the carcass each cut is, and what was lost (bones trimmed off, fat, water). */
export function breakdownYield(sourceMilli: number, cuts: number[]) {
  const out = cuts.reduce((a, q) => a + q, 0);
  return { outMilli: out, wasteMilli: Math.max(0, sourceMilli - out), yieldBp: sourceMilli > 0 ? Math.round((out * 10000) / sourceMilli) : 0 };
}
