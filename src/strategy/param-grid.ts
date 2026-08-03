import type { StrategyParam } from "./registry.js";

/**
 * Generate a Cartesian-product parameter grid for the walk-forward optimizer.
 *
 * Params with `optimizable: false` are excluded from the sweep and appear in
 * every combo with a fixed value: sidebarValues[key] when provided (sidebar
 * overrides registry defaults), otherwise param.default. This ensures that
 * physical constants (e.g. defaultRate) never become optimisation targets.
 *
 * Params with `gridValues` use those explicit values instead of the implicit
 * min/max/step sweep, which is degenerate for params where near-zero values
 * collapse strategy logic.
 *
 * The function caps the grid at maxCombinations by striding (not random sampling),
 * so the returned set is evenly spaced across the full grid.
 */
export function generateParamGrid(
  params: StrategyParam[],
  maxCombinations = 200,
  sidebarValues: Record<string, number> = {},
): Record<string, number>[] {
  const fixed   = params.filter(p => p.optimizable === false);
  const tunable = params.filter(p => p.optimizable !== false);

  // All fixed params go into every combo at their current (sidebar or default) value
  const fixedBase: Record<string, number> = {};
  for (const p of fixed) {
    fixedBase[p.key] = Object.prototype.hasOwnProperty.call(sidebarValues, p.key)
      ? sidebarValues[p.key]
      : p.default;
  }

  if (tunable.length === 0) return [{ ...fixedBase }];

  let combos: Record<string, number>[] = [{ ...fixedBase }];
  for (const p of tunable) {
    const vals: number[] = p.gridValues && p.gridValues.length > 0
      ? p.gridValues
      : (() => {
          const v: number[] = [];
          for (let x = p.min; x <= p.max + 1e-9; x += p.step) {
            v.push(Math.round(x * 1000) / 1000);
          }
          return v;
        })();

    const next: Record<string, number>[] = [];
    for (const combo of combos) {
      for (const v of vals) next.push({ ...combo, [p.key]: v });
    }
    combos = next;
    if (combos.length > 50_000) { combos = combos.slice(0, 50_000); break; }
  }

  if (combos.length > maxCombinations) {
    const stride = Math.ceil(combos.length / maxCombinations);
    return combos.filter((_, i) => i % stride === 0).slice(0, maxCombinations);
  }
  return combos;
}
