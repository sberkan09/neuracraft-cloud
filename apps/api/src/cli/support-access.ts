// Support access for an account, recorded by the operator when the account agreed outside the web app
// (an email, a partner's closed beta). The account can also grant or end it itself (PATCH /v1/me).
// With it, the operator console shows the account's jobs' pictures and texts; every view is logged.
//   node dist/src/cli/support-access.js --email partner@example.com --days 30 --note "closed beta, testers agreed by email"
//   node dist/src/cli/support-access.js --email partner@example.com --days 0     (ends it)
import { userInfo } from "node:os";
import { loadConfig } from "../config.js";
import { connect, migrate } from "../db.js";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const email = opt("email")?.toLowerCase(), days = Number(opt("days")), note = opt("note");
if (!email || !Number.isInteger(days) || days < 0 || days > 90 || (days > 0 && !note)) {
  console.error('usage: support-access --email <account> --days 1-90 --note "<how the account agreed>" | --days 0');
  process.exit(2);
}
const config = loadConfig();
const db = connect(config.databaseUrl);
try {
  await migrate(db, config.migrationsDir);
  const r = await db.query<{ id: string; until: Date | null }>(
    `UPDATE users SET support_access_until = CASE WHEN $2 > 0 THEN now() + make_interval(days => $2) END, support_access_note = $3
      WHERE email = $1 RETURNING id, support_access_until AS until`,
    [email, days, days > 0 ? note : null],
  );
  if (!r.rows[0]) throw new Error(`no account ${email}`);
  await db.query("INSERT INTO moderation_log (operator, action, user_id, note) VALUES ($1, 'support_access', $2, $3)", [
    opt("operator") ?? userInfo().username,
    r.rows[0].id,
    days > 0 ? `granted ${days} days: ${note}` : "ended",
  ]);
  console.log(`${email}: support access ${r.rows[0].until ? `until ${r.rows[0].until.toISOString()}` : "off"}`);
} finally {
  await db.end();
}
