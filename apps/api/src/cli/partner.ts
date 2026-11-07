// Partner settings (issue #21): the per-end-user daily quota of a partner account.
//   node dist/src/cli/partner.js --email partner@example.com --daily-jobs 20 [--timezone Europe/Istanbul]
//   node dist/src/cli/partner.js --email partner@example.com --daily-jobs none      (no quota)
//   ... --allowance on|off   end users' jobs draw on allowances the partner's server grants
import { loadConfig } from "../config.js";
import { connect, migrate } from "../db.js";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const email = opt("email"), daily = opt("daily-jobs"), tz = opt("timezone"), allowance = opt("allowance");
const jobs = daily === "none" ? null : Number(daily);
if (!email || daily === undefined || (jobs !== null && !(Number.isInteger(jobs) && jobs >= 0)) || (allowance && allowance !== "on" && allowance !== "off")) {
  console.error("usage: partner --email <account> --daily-jobs <N|none> [--timezone Europe/Istanbul] [--allowance on|off]");
  process.exit(2);
}
const config = loadConfig();
const db = connect(config.databaseUrl);
try {
  await migrate(db, config.migrationsDir);
  const u = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
  if (!u.rows[0]) throw new Error(`no account ${email}`);
  if (tz) await db.query("SELECT now() AT TIME ZONE $1", [tz]);  // an unknown time zone fails here
  await db.query(
    `INSERT INTO partners (user_id, end_user_daily_jobs, quota_timezone, allowance_required) VALUES ($1, $2, coalesce($3, 'Europe/Istanbul'), coalesce($4, false))
     ON CONFLICT (user_id) DO UPDATE SET end_user_daily_jobs = $2, quota_timezone = coalesce($3, partners.quota_timezone),
       allowance_required = coalesce($4, partners.allowance_required), updated_at = now()`,
    [u.rows[0].id, jobs, tz ?? null, allowance ? allowance === "on" : null],
  );
  console.log(`${email}: ${jobs === null ? "no daily quota" : `${jobs} jobs a day per end user`}`);
} finally {
  await db.end();
}
