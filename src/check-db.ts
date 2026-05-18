import Database from "better-sqlite3";

const db = new Database("data/bot.db", { readonly: true });

const events = db.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT 5").all();
const trades = db.prepare("SELECT * FROM trades ORDER BY created_at DESC").all();

console.log("=== Last 5 events ===");
if (events.length === 0) {
  console.log("  (none)");
} else {
  for (const row of events) console.log(row);
}

console.log("\n=== Trades ===");
if (trades.length === 0) {
  console.log("  (none)");
} else {
  for (const row of trades) console.log(row);
}

db.close();
