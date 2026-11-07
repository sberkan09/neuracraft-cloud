// Issues an app token (nc_app_...) to a registered client application, acting as the given account
// (the partner's), or a personal access token for scripts. Prints the secret once.
//   node dist/src/cli/create-token.js --email partner@example.com --kind app --name "GM Cebi" [--scopes jobs:submit,jobs:read] [--days 365]
import { loadConfig } from "../config.js";
import { connect, migrate } from "../db.js";
import { createToken, SCOPES, type Scope } from "../auth.js";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const email = opt("email"), kind = opt("kind") ?? "app", name = opt("name");
const scopes = (opt("scopes") ?? "jobs:submit,jobs:read,assets:read").split(",") as Scope[];
if (!email || !name || (kind !== "app" && kind !== "pat") || !scopes.every((s) => SCOPES.includes(s))) {
  console.error(`usage: create-token --email <account> --name <name> [--kind app|pat] [--scopes ${SCOPES.join(",")}] [--days N]`);
  process.exit(2);
}
const config = loadConfig();
const db = connect(config.databaseUrl);
await migrate(db, config.migrationsDir);
const u = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
if (!u.rows[0]) throw new Error(`no account ${email}`);
const days = opt("days") ? Number(opt("days")) : null;
const t = await createToken(db, u.rows[0].id, kind, name, scopes, days ? new Date(Date.now() + days * 86400000) : null);
console.log(t.secret);
await db.end();
