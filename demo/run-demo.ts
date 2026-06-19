/**
 * The side-by-side Blindfold demo runner.
 *
 *   npm run demo
 *
 * Runs Agent A (no Blindfold) and Agent B (with Blindfold) against the
 * IDENTICAL prompt-injection attack, then prints a verdict table.
 */
import { runAgentA } from "./agent-a-leaks/index.ts";
import { runAgentB } from "./agent-b-blindfolded/index.ts";

async function main(): Promise<void> {
  intro();

  const a = await runAgentA();
  const b = await runAgentB();

  verdict(a, b);
  process.exit(a.leaked && !b.leaked ? 0 : 2);
}

function intro(): void {
  const w = process.stdout.columns ?? 72;
  const bar = "═".repeat(Math.min(72, w));
  process.stdout.write(`\n${bar}\n  Blindfold — side-by-side prompt-injection demo\n${bar}\n`);
  process.stdout.write(
    `  Two agents.  Same model.  Same task.  Same attack.\n  One leaks its OpenAI key.  The other can't — there's nothing to leak.\n`,
  );
}

function verdict(a: { attackerReceived: string[]; leaked: boolean }, b: { attackerReceived: string[]; leaked: boolean }): void {
  const w = process.stdout.columns ?? 72;
  const bar = "═".repeat(Math.min(72, w));
  process.stdout.write(`\n${bar}\n  VERDICT\n${bar}\n`);
  process.stdout.write(`  Without Blindfold:  attacker received  ${JSON.stringify(a.attackerReceived)}\n`);
  process.stdout.write(`                      key was leaked?     ${a.leaked ? "🚨 YES" : "✅ no"}\n`);
  process.stdout.write(`  With Blindfold:     attacker received  ${JSON.stringify(b.attackerReceived)}\n`);
  process.stdout.write(`                      key was leaked?     ${b.leaked ? "🚨 YES (bug!)" : "✅ no — sentinel only"}\n`);
  process.stdout.write(`${bar}\n`);

  if (a.leaked && !b.leaked) {
    process.stdout.write("  ✅ Demonstration successful: Blindfold neutralised the same attack.\n");
  } else if (!a.leaked) {
    process.stdout.write("  ⚠ Agent A did NOT leak — the injection may have changed. Check demo/shared/injection-page.ts.\n");
  } else {
    process.stdout.write("  🚨 Agent B leaked — Blindfold is broken. Investigate immediately.\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
