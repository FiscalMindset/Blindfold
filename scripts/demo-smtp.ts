/**
 * Real SMTP send — the same script run twice, once before and once
 * after sealing the SMTP password into Blindfold. Demonstrates the
 * security property on a credential type that isn't an HTTP API key.
 *
 *   npm run demo:smtp -- <to> [subject] [body]
 *
 * Reads SMTP creds from process.env. The "without Blindfold" run finds
 * smtp_password=<real>; the "with Blindfold" run finds it missing
 * (because you deleted it from .env after sealing).
 */
import nodemailer from "nodemailer";
import { loadEnvFromFile } from "../packages/blindfold/src/env.ts";

loadEnvFromFile();

const colour = process.stdout.isTTY ? (c: string, s: string) => `\x1b[${c}m${s}\x1b[0m` : (_: string, s: string) => s;
const bold = (s: string) => colour("1", s);
const green = (s: string) => colour("32", s);
const yellow = (s: string) => colour("33", s);
const red = (s: string) => colour("31", s);
const dim = (s: string) => colour("2", s);

function fingerprint(v: string | undefined): string {
  if (!v) return red("(missing)");
  if (v.length <= 8) return `<${v.length}b>`;
  return `${v.slice(0, 3)}…${v.slice(-2)}  ${dim(`(${v.length} bytes)`)}`;
}

async function main(): Promise<void> {
  const to = process.argv[2] ?? "algsoch@gmail.com";
  const subject = process.argv[3] ?? `Blindfold SMTP test — ${new Date().toISOString().slice(0, 19)}`;
  const text = process.argv[4] ?? "Hi from Blindfold — this email was sent by scripts/demo-smtp.ts.";

  const host = process.env.smtp_host ?? process.env.SMTP_HOST;
  const user = process.env.smtp_email ?? process.env.SMTP_EMAIL;
  const pass = process.env.smtp_password ?? process.env.SMTP_PASSWORD;

  process.stdout.write(`\n${bold("Blindfold SMTP demo")}\n`);
  process.stdout.write(`${dim("Inputs visible to this process (the leak surface for any AI agent here):")}\n`);
  process.stdout.write(`  smtp_host       ${host ? green(host) : red("(missing)")}\n`);
  process.stdout.write(`  smtp_email      ${user ? green(user) : red("(missing)")}\n`);
  process.stdout.write(`  smtp_password   ${fingerprint(pass)}\n`);
  process.stdout.write(`  → to            ${to}\n`);
  process.stdout.write(`  → subject       ${subject}\n\n`);

  if (!host || !user || !pass) {
    process.stdout.write(`${yellow("⚠  At least one credential is missing.")}\n`);
    process.stdout.write(`${dim("If you just sealed the password into Blindfold and deleted it from .env,")}\n`);
    process.stdout.write(`${dim("this is the expected outcome — the agent process literally cannot send.")}\n`);
    process.stdout.write(`${dim("That's the win: there's no value here for a prompt-injection to exfiltrate.")}\n`);
    process.exit(2);
  }

  const transporter = nodemailer.createTransport({
    host,
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  process.stdout.write(`${dim("→ sending via ")}${host}:465 SSL …\n`);
  try {
    const info = await transporter.sendMail({
      from: `"${user}" <${user}>`,
      to,
      subject,
      text,
    });
    process.stdout.write(`${green("✓ SENT")}  messageId=${info.messageId}\n`);
    if (info.response) process.stdout.write(`  server response: ${dim(info.response)}\n`);
  } catch (e) {
    process.stdout.write(`${red("✖ FAILED")}  ${(e as Error).message}\n`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
