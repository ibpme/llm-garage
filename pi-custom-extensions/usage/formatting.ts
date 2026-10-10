import type { UsageReport } from "./providers.ts";

export function countdown(milliseconds: number): string {
  if (milliseconds <= 0) return "reset time passed";
  const minutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", remainder ? `${remainder}m` : ""]
    .filter(Boolean).slice(0, 2).join(" ");
}

export function formatUsage(reports: readonly UsageReport[], now = Date.now()): string {
  if (reports.length === 0) return "No supported providers are configured. Use /login opencode-go or /login openai.";
  return reports.map((report) => {
    const lines = [report.title + (report.plan ? ` · ${report.plan}` : ""), ""];
    for (const window of report.windows) {
      lines.push(window.label);
      if (window.usedPercent !== undefined) {
        const percent = Math.round(window.usedPercent * 10) / 10;
        const remaining = Math.round((100 - window.usedPercent) * 10) / 10;
        const filled = Math.round(window.usedPercent / 5);
        lines.push(`  [${"#".repeat(filled)}${"-".repeat(20 - filled)}] ${percent}% used · ${remaining}% remaining`);
      }
      if (window.status === "rate-limited") lines.push("  Rate limited");
      if (window.resetsAt !== undefined) {
        const reset = new Date(window.resetsAt);
        lines.push(`  Reset: ${reset.toLocaleString()} · ${countdown(window.resetsAt - now)}`);
      }
      if (window.note) lines.push(`  ${window.note}`);
      lines.push("");
    }
    lines.push(...report.notes);
    return lines.join("\n").trimEnd();
  }).join("\n\n──────────────────────────────\n\n");
}
