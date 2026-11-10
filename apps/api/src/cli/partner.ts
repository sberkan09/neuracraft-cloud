// Partner settings (issue #21, #48). Each option is optional; the others keep their values.
//   node dist/src/cli/partner.js --email partner@example.com --daily-jobs 20 [--timezone Europe/Istanbul]
//   ... --daily-jobs none                 no per-end-user quota
//   ... --partner-daily-jobs 300|none     a ceiling across all end users a day
//   ... --allowance on|off                end users' jobs draw on allowances the partner's server grants
//   ... --require-end-user-tokens on|off  only signed-in end users (nc_eu_ tokens), no app token + X-End-User
//   ... --block eu_... / --unblock eu_... a signed-in end user
import { loadConfig } from "../config.js";
import { connect, migrate } from "../db.js";
import { setBlocked } from "../endusers.js";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const count = (v: string | undefined) => (v === undefined ? undefined : v === "none" ? null : Number(v));
const onOff = (v: string | undefined) => (v === undefined ? undefined : v === "on" ? true : v === "off" ? false : NaN);
const email = opt("email"), tz = opt("timezone"), block = opt("block"), unblock = opt("unblock");
const daily = count(opt("daily-jobs")), partnerDaily = count(opt("partner-daily-jobs"));
const allowance = onOff(opt("allowance")), euOnly = onOff(opt("require-end-user-tokens"));
const okCount = (n: number | null | undefined) => n === undefined || n === null || (Number.isInteger(n) && n >= 0);
const okFlag = (b: boolean | number | undefined) => b === undefined || typeof b === "boolean";
const nothing = [daily, partnerDaily, allowance, euOnly, tz, block, unblock].every((v) => v === undefined);
if (!email || nothing || !okCount(daily) || !okCount(partnerDaily) || !okFlag(allowance) || !okFlag(euOnly)) {
  console.error(
    "usage: partner --email <account> [--daily-jobs N|none] [--partner-daily-jobs N|none] [--timezone Europe/Istanbul] [--allowance on|off] [--require-end-user-tokens on|off] [--block <end user>] [--unblock <end user>]",
  );
  process.exit(2);
}
const config = loadConfig();
const db = connect(config.databaseUrl);
try {
  await migrate(db, config.migrationsDir);
  const u = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
  if (!u.rows[0]) throw new Error(`no account ${email}`);
  const id = u.rows[0].id;
  if (tz) await db.query("SELECT now() AT TIME ZONE $1", [tz]);  // an unknown time zone fails here
  await db.query("INSERT INTO partners (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [id]);
  const set: [string, unknown][] = [];
  if (daily !== undefined) set.push(["end_user_daily_jobs", daily]);
  if (partnerDaily !== undefined) set.push(["partner_daily_jobs", partnerDaily]);
  if (tz) set.push(["quota_timezone", tz]);
  if (allowance !== undefined) set.push(["allowance_required", allowance]);
  if (euOnly !== undefined) set.push(["require_end_user_tokens", euOnly]);
  if (set.length)
    await db.query(`UPDATE partners SET ${set.map(([c], i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE user_id = $1`, [id, ...set.map(([, v]) => v)]);
  for (const [who, blocked] of [[block, true], [unblock, false]] as const)
    if (who && !(await setBlocked(db, id, who, blocked))) throw new Error(`no signed-in end user ${who}`);
  const p = (await db.query("SELECT end_user_daily_jobs, partner_daily_jobs, quota_timezone, allowance_required, require_end_user_tokens FROM partners WHERE user_id = $1", [id])).rows[0];
  console.log(`${email}:`, p, block ? `blocked ${block}` : "", unblock ? `unblocked ${unblock}` : "");
} finally {
  await db.end();
}
