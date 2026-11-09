// Grants credits to an account (an operator's top-up, e.g. a partner during the beta), in the ledger.
//   node dist/src/cli/grant-credits.js --email partner@example.com --credits 5000 [--reason "beta"]
// 1 credit = 1000 millicredits; a GPU minute costs 10 credits (plans.ts).
import { loadConfig } from "../config.js";
import { connect, migrate } from "../db.js";
import { balance, entry } from "../ledger.js";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const email = opt("email"), credits = Number(opt("credits")), reason = opt("reason") ?? "operator grant";
if (!email || !Number.isInteger(credits) || credits <= 0 || credits > 10_000_000) {
  console.error('usage: grant-credits --email <account> --credits <N> [--reason "..."]');
  process.exit(2);
}
const config = loadConfig();
const db = connect(config.databaseUrl);
try {
  await migrate(db, config.migrationsDir);
  const u = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
  if (!u.rows[0]) throw new Error(`no account ${email}`);
  await entry(db, u.rows[0].id, "grant", credits * 1000, undefined, reason.slice(0, 200));
  console.log(`${email}: +${credits} credits, balance ${(await balance(db, u.rows[0].id)) / 1000}`);
} finally {
  await db.end();
}
