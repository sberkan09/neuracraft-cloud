// Transactional email: only the sign-in codes of partner apps' end users (issue #48). Brevo's API in
// production (MAIL_PROVIDER=brevo, BREVO_API_KEY, MAIL_FROM); "log" prints the code to the API's log
// for development; none ("") turns email sign-in off (auth.sign_in_unavailable).
import type { Config } from "./config.js";

export interface SignInMail {
  to: string;
  code: string;
  appName: string; // the partner client's name
  locale: string; // "tr" or "en"
  minutes: number; // how long the code is valid
}

export interface Mailer {
  sendSignInCode(m: SignInMail): Promise<void>;
}

export function signInMessage(m: SignInMail): { subject: string; text: string; html: string } {
  const tr = m.locale.startsWith("tr");
  const subject = tr ? `${m.appName} giriş kodun: ${m.code}` : `Your ${m.appName} sign-in code: ${m.code}`;
  const lines = tr
    ? [`${m.appName} için giriş kodun:`, m.code, `Kod ${m.minutes} dakika geçerli.`, "Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin."]
    : [`Your sign-in code for ${m.appName}:`, m.code, `The code is valid for ${m.minutes} minutes.`, "If you did not ask for it, you can ignore this email."];
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html =
    `<p>${esc(lines[0]!)}</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${esc(m.code)}</p>` +
    `<p>${esc(lines[2]!)}</p><p style="color:#666">${esc(lines[3]!)}</p><p style="color:#666">NeuraCraft</p>`;
  return { subject, text: `${lines.join("\n\n")}\n\nNeuraCraft\n`, html };
}

// "Name <address>" or a bare address.
export function parseFrom(from: string): { email: string; name?: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m ? { email: m[2]!, ...(m[1] ? { name: m[1] } : {}) } : { email: from.trim() };
}

export class BrevoMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async sendSignInCode(m: SignInMail): Promise<void> {
    const msg = signInMessage(m);
    const r = await this.fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": this.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: parseFrom(this.from), to: [{ email: m.to }], subject: msg.subject, textContent: msg.text, htmlContent: msg.html, tags: ["sign-in-code"] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`brevo: sending failed (${r.status})`);  // the body may echo the address: not logged
  }
}

// Development: the code goes to the API's log (never in production: it would log addresses).
export class LogMailer implements Mailer {
  async sendSignInCode(m: SignInMail): Promise<void> {
    console.log(`[mail] sign-in code for ${m.appName} to ${m.to}: ${m.code}`);
  }
}

export function mailerFrom(config: Config): Mailer | null {
  if (config.mail.provider === "brevo") {
    if (!config.mail.brevoApiKey || !config.mail.from) {
      console.warn("MAIL_PROVIDER=brevo needs BREVO_API_KEY and MAIL_FROM: end-user sign-in is off");
      return null;
    }
    return new BrevoMailer(config.mail.brevoApiKey, config.mail.from);
  }
  if (config.mail.provider === "log") return new LogMailer();
  return null;
}
