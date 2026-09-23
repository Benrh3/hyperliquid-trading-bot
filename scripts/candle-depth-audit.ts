// scripts/candle-depth-audit.ts
// Paginate backwards through HYPE and BTC 1h candleSnapshot to find true
// history depth. Reports total hours, gaps, and per-batch stats.
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";

const info = new InfoClient({ transport: new HttpTransport({ isTestnet: false }) });
const HOUR_MS = 3_600_000;
const CAP     = 5_000;      // expected API record cap per request

type Candle = { t: number; o: string };

interface BatchStat {
  iter:     number;
  count:    number;
  earliest: number;
  latest:   number;
  capped:   boolean; // exactly CAP records — possible truncation on final call
}

async function walk(coin: string): Promise<{ candles: Candle[]; batches: BatchStat[] }> {
  const candles: Candle[] = [];
  const batches: BatchStat[] = [];
  let endTime = Date.now();
  let iter    = 0;

  while (true) {
    iter++;
    const res = await info.candleSnapshot({
      coin, interval: "1h" as any, startTime: 0, endTime,
    }) as any[];

    if (!res || res.length === 0) {
      console.log(`  [${coin}] iter ${iter}: empty — done.`);
      break;
    }

    res.sort((a: any, b: any) => (a.t as number) - (b.t as number));
    const earliest = res[0].t  as number;
    const latest   = res[res.length - 1].t as number;
    const capped   = res.length === CAP;

    batches.push({ iter, count: res.length, earliest, latest, capped });
    for (const c of res) candles.push({ t: c.t as number, o: c.o as string });

    console.log(`  [${coin}] iter ${iter}: ${res.length} candles | ${new Date(earliest).toISOString()} → ${new Date(latest).toISOString()}${capped ? " [CAP]" : ""}`);

    if (earliest >= endTime) {
      console.log(`  [${coin}] WARNING: no progress, stopping.`);
      break;
    }
    endTime = earliest - 1; // exclusive: next request returns candles strictly before this
  }

  return { candles, batches };
}

function audit(coin: string, candles: Candle[], batches: BatchStat[], fundingStart?: number) {
  if (candles.length === 0) {
    console.log(`  ${coin}: no candles.`);
    return;
  }

  // De-duplicate and sort (batches may overlap on boundary)
  const seen = new Set<number>();
  const unique = candles.filter(c => { if (seen.has(c.t)) return false; seen.add(c.t); return true; });
  unique.sort((a, b) => a.t - b.t);

  const earliest = unique[0]!.t;
  const latest   = unique[unique.length - 1]!.t;

  const totalHours    = unique.length;
  const expectedHours = Math.round((latest - earliest) / HOUR_MS) + 1;
  const gapHours      = expectedHours - totalHours;

  const gaps: { from: string; to: string; hours: number }[] = [];
  for (let i = 1; i < unique.length; i++) {
    const delta = unique[i]!.t - unique[i - 1]!.t;
    if (delta > HOUR_MS) {
      gaps.push({
        from:  new Date(unique[i - 1]!.t).toISOString(),
        to:    new Date(unique[i]!.t).toISOString(),
        hours: Math.round(delta / HOUR_MS) - 1,
      });
    }
  }

  // Non-final batches being exactly CAP is expected; flag only the FINAL batch if capped
  const finalBatch  = batches[batches.length - 1];
  const finalCapped = finalBatch?.capped ?? false;

  console.log(`\n══ ${coin} 1h audit ══`);
  console.log(`  Earliest candle:    ${new Date(earliest).toISOString()}`);
  console.log(`  Latest candle:      ${new Date(latest).toISOString()}`);
  console.log(`  Total candles:      ${totalHours}`);
  console.log(`  Expected (no gaps): ${expectedHours}`);
  console.log(`  Gap hours:          ${gapHours}`);
  console.log(`  Gap events:         ${gaps.length}`);
  console.log(`  Final batch capped: ${finalCapped} (${finalBatch?.count ?? 0} records)`);
  console.log(`  Batches flagged [CAP]: ${batches.filter(b => b.capped).length} / ${batches.length}`);

  if (gaps.length > 0 && gaps.length <= 20) {
    console.log(`  Gaps:`);
    for (const g of gaps) console.log(`    ${g.from} → ${g.to}  (${g.hours}h missing)`);
  } else if (gaps.length > 20) {
    console.log(`  (${gaps.length} gaps — showing first 5 and last 5)`);
    for (const g of gaps.slice(0, 5))  console.log(`    ${g.from} → ${g.to}  (${g.hours}h)`);
    console.log(`    ...`);
    for (const g of gaps.slice(-5))    console.log(`    ${g.from} → ${g.to}  (${g.hours}h)`);
  }

  if (fundingStart !== undefined) {
    const covers = earliest <= fundingStart;
    const fundingStr = new Date(fundingStart).toISOString();
    console.log(`  Funding start (${fundingStr}): candles ${covers ? "COVER ✓" : "DO NOT COVER ✗ (gap of " + Math.round((fundingStart - earliest) / HOUR_MS) + "h)"}`);
  }
}

const HYPE_FUNDING_START = new Date("2024-12-05T00:00:00Z").getTime();

console.log("── HYPE 1h walk ──");
const hype = await walk("HYPE");

console.log("\n── BTC 1h walk ──");
const btc  = await walk("BTC");

audit("HYPE", hype.candles, hype.batches, HYPE_FUNDING_START);
audit("BTC",  btc.candles,  btc.batches);
