// The review queue for operators (issue #18): reports from users and outputs the classifier held.
//   node dist/src/cli/review.js list [--all] [--limit N]
//   node dist/src/cli/review.js show <report-id>          the report, the job's prompt, links to the output and inputs (1 h)
//   node dist/src/cli/review.js dismiss <report-id> [--note text]
//   node dist/src/cli/review.js remove <report-id> [--note text]      removes the asset for its owner
//   node dist/src/cli/review.js flag-account <report-id> [--note text]
// Every action is logged in moderation_log with the operator (--operator, else $USER).
// Links are signed for this API's storage: set STORAGE_URL_PREFIX to the API's public address.
import { userInfo } from "node:os";
import { loadConfig } from "../config.js";
import { connect, migrate } from "../db.js";
import { dismissReport, flagAccount, listReports, removeReportedAsset, showReport } from "../moderation.js";
import { LocalStorage } from "../storage.js";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const [cmd, id] = args;
const usage = () => {
  console.error("usage: review list [--all] [--limit N] | show <id> | dismiss <id> | remove <id> | flag-account <id>  [--note text] [--operator name]");
  process.exit(2);
};
if (!cmd || (cmd !== "list" && !id)) usage();

const config = loadConfig();
if (config.storage.kind !== "local") throw new Error("review: only local storage is wired up so far");
const db = connect(config.databaseUrl);
await migrate(db, config.migrationsDir);
const storage = new LocalStorage(config.storage.dir, config.signingKey, config.publicUrl);
const operator = opt("operator") ?? process.env.USER ?? userInfo().username;
const note = opt("note");

try {
  if (cmd === "list") {
    const rows = await listReports(db, { status: args.includes("--all") ? "all" : "open", limit: Number(opt("limit") ?? 50) });
    if (!rows.length) console.log("no reports");
    for (const r of rows) {
      const prompt = (r.snapshot.prompt as { narrative?: string; prompt?: string } | undefined) ?? {};
      console.log(
        [
          r.id,
          r.created_at.toISOString().slice(0, 16),
          r.status,
          `${r.source}:${r.reason}`,
          `asset ${r.asset_id} (${r.asset_status})`,
          `${r.owner_email ?? "?"}${r.owner_flagged ? " [flagged]" : ""}`,
          String(r.snapshot.preset ?? "workflow"),
          JSON.stringify((prompt.narrative ?? prompt.prompt ?? "").slice(0, 60)),
        ].join("  "),
      );
    }
  } else if (cmd === "show") {
    const r = await showReport(db, storage, id!);
    if (!r) throw new Error(`no report ${id}`);
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === "dismiss") {
    await dismissReport(db, id!, operator, note);
    console.log(`dismissed ${id}`);
  } else if (cmd === "remove") {
    await removeReportedAsset(db, id!, operator, note);
    console.log(`removed the asset of ${id}`);
  } else if (cmd === "flag-account") {
    await flagAccount(db, id!, operator, note);
    console.log(`flagged the account of ${id}`);
  } else usage();
} finally {
  await db.end();
}
