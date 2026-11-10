// A partner app's public client id for end-user sign-in (issue #48). Not a secret: it ships in the app.
//   node dist/src/cli/partner-client.js --email partner@example.com --name "GM Cebi"   prints nc_client_...
//   node dist/src/cli/partner-client.js --email partner@example.com --list
//   node dist/src/cli/partner-client.js --disable nc_client_...    (sign-in and its tokens stop)
import { loadConfig } from "../config.js";
import { connect, migrate } from "../db.js";
import { createClient } from "../endusers.js";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const email = opt("email"), name = opt("name"), disable = opt("disable"), enable = opt("enable"), list = args.includes("--list");
if (!disable && !enable && (!email || (!name && !list))) {
  console.error("usage: partner-client --email <account> (--name <app name> | --list) | --disable <client id> | --enable <client id>");
  process.exit(2);
}
const config = loadConfig();
const db = connect(config.databaseUrl);
try {
  await migrate(db, config.migrationsDir);
  if (disable || enable) {
    const r = await db.query("UPDATE partner_clients SET enabled = $2 WHERE id = $1", [disable ?? enable, !disable]);
    if (!r.rowCount) throw new Error(`no client ${disable ?? enable}`);
    console.log(`${disable ?? enable}: ${disable ? "disabled" : "enabled"}`);
  } else {
    const u = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email!.toLowerCase()]);
    if (!u.rows[0]) throw new Error(`no account ${email}`);
    if (list) {
      const r = await db.query<{ id: string; name: string; enabled: boolean }>("SELECT id, name, enabled FROM partner_clients WHERE user_id = $1 ORDER BY created_at", [u.rows[0].id]);
      for (const c of r.rows) console.log(`${c.id}  ${c.name}${c.enabled ? "" : "  (disabled)"}`);
    } else {
      console.log((await createClient(db, u.rows[0].id, name!)).id);
    }
  }
} finally {
  await db.end();
}
