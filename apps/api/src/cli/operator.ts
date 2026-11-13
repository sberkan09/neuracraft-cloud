// Operators of this service: who may open the operator console (#admin in the web app).
//   node dist/src/cli/operator.js --email you@example.com --on | --off
//   node dist/src/cli/operator.js --list
import { loadConfig } from "../config.js";
import { connect, migrate } from "../db.js";

const args = process.argv.slice(2);
const i = args.indexOf("--email");
const email = i >= 0 ? args[i + 1]?.toLowerCase() : undefined;
const on = args.includes("--on"), off = args.includes("--off"), list = args.includes("--list");
if (!list && (!email || on === off)) {
  console.error("usage: operator --email <account> --on|--off | --list");
  process.exit(2);
}
const config = loadConfig();
const db = connect(config.databaseUrl);
try {
  await migrate(db, config.migrationsDir);
  if (list) {
    for (const r of (await db.query<{ email: string }>("SELECT email FROM users WHERE operator ORDER BY email")).rows) console.log(r.email);
  } else {
    const r = await db.query("UPDATE users SET operator = $2 WHERE email = $1", [email, on]);
    if (!r.rowCount) throw new Error(`no account ${email}: sign up on the web app first`);
    console.log(`${email}: ${on ? "operator" : "not an operator"}`);
  }
} finally {
  await db.end();
}
