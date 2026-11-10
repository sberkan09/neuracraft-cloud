// Sends one sign-in code email, to check the email setup (MAIL_PROVIDER, BREVO_API_KEY, MAIL_FROM).
//   docker compose exec api node apps/api/dist/src/cli/mail-test.js --to you@example.com
// Prints the provider's error when sending fails (the API itself does not log it).
import { loadConfig } from "../config.js";
import { mailerFrom } from "../mailer.js";

const args = process.argv.slice(2);
const i = args.indexOf("--to");
const to = i >= 0 ? args[i + 1] : undefined;
if (!to) {
  console.error("usage: mail-test --to <address>");
  process.exit(2);
}
const config = loadConfig();
const mailer = mailerFrom(config);
if (!mailer) {
  console.error(`no mailer: MAIL_PROVIDER=${config.mail.provider || "(empty)"}, BREVO_API_KEY ${config.mail.brevoApiKey ? "set" : "missing"}, MAIL_FROM=${config.mail.from || "(empty)"}`);
  process.exit(1);
}
try {
  await mailer.sendSignInCode({ to, code: "123456", appName: "NeuraCraft (test)", locale: "tr", minutes: 10 });
  console.log(`sent to ${to} from ${config.mail.from} (${config.mail.provider}); check the inbox and the spam folder`);
} catch (e) {
  console.error(String((e as Error).message), (e as { body?: string }).body ?? "");
  process.exit(1);
}
