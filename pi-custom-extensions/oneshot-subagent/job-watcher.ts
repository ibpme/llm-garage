import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { AgentJobs, JobSnapshot } from "../shared/agent-jobs/jobs.ts";
import { isTerminal } from "../shared/agent-jobs/store.ts";
import { oneLine } from "./events.ts";
import { duration, isOutstanding, noticeText } from "./job-results.ts";
import type { NoticeMode } from "./config.ts";

export const NOTICE_TYPE = "subagent-job-notice";
export const WIDGET_KEY = "subagent-jobs";

export interface NoticeDetails { jobs: { id: string; name: string; state: string; reason?: string }[] }

export function indicatorLines(jobs: JobSnapshot[], theme: Theme, width: number, expanded: boolean, now = Date.now()): string[] {
  const shown = jobs.filter(isOutstanding);
  if (!shown.length || width < 1) return [];
  const count = (test: (job: JobSnapshot) => boolean) => shown.filter(test).length;
  const parts = [
    [count((job) => !isTerminal(job.status.state) && job.liveness !== "unknown"), "running", "accent"],
    [count((job) => !isTerminal(job.status.state) && job.liveness === "unknown"), "unknown", "warning"],
    [count((job) => job.status.state === "succeeded"), "ready", "success"],
    [count((job) => ["failed", "timed-out", "interrupted"].includes(job.status.state)), "failed", "error"],
    [count((job) => job.status.state === "cancelled"), "cancelled", "warning"],
  ] as const;
  const left = `${theme.bold("Agents")}  ${parts.filter(([n]) => n).map(([n, label, color]) => theme.fg(color, `${n} ${label}`)).join(theme.fg("dim", " · "))}`;
  const hint = theme.fg("dim", "/agents");
  const gap = width - visibleWidth(left) - visibleWidth(hint);
  const lines = [gap >= 2 ? left + " ".repeat(gap) + hint : truncateToWidth(left, width)];
  if (expanded) {
    for (const job of shown.slice(0, 3)) {
      const { status } = job;
      const running = !isTerminal(status.state);
      const icon = running ? "◌" : status.state === "succeeded" ? "✓" : status.state === "cancelled" ? "■" : "✗";
      const time = running ? duration(now - job.request.createdAt) : duration((status.finishedAt ?? now) - job.request.createdAt);
      const quiet = running && status.lastActivityAt && now - status.lastActivityAt > 30_000
        ? ` · quiet ${duration(now - status.lastActivityAt)}` : "";
      const activity = running ? status.details.activity.at(-1) : undefined;
      lines.push(truncateToWidth(`  ${icon} ${oneLine(job.request.name, 40)}  ` +
        theme.fg("muted", `${status.state} ${time}${quiet}`) + (activity ? theme.fg("dim", ` · ${oneLine(activity, 120)}`) : ""), width));
    }
    if (shown.length > 3) lines.push(truncateToWidth(theme.fg("dim", `  …${shown.length - 3} more in /agents`), width));
  }
  return lines;
}

/**
 * Follows the jobs owned by the active root session: keeps the indicator
 * current and delivers completion notices once, only into the owner's branch.
 */
export class JobWatcher {
  private readonly pi: ExtensionAPI;
  private readonly store: AgentJobs;
  private readonly ctx: ExtensionContext;
  private readonly owner: string;
  private jobs: JobSnapshot[] = [];
  private unsubscribe?: () => void;
  private delivering = Promise.resolve();
  private readonly mode: NoticeMode;
  expanded = false;

  constructor(pi: ExtensionAPI, store: AgentJobs, ctx: ExtensionContext, mode: NoticeMode = "followUp") {
    this.pi = pi;
    this.store = store;
    this.ctx = ctx;
    this.mode = mode;
    this.owner = ctx.sessionManager.getSessionId();
  }

  start(intervalMs = 1_000): void {
    this.unsubscribe = this.store.subscribe({ owner: this.owner }, (jobs) => this.update(jobs), intervalMs);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try { if (this.ctx.hasUI) this.ctx.ui.setWidget(WIDGET_KEY, undefined); }
    catch { /* The UI may already be torn down during shutdown. */ }
  }

  get current(): JobSnapshot[] { return this.jobs; }

  update(jobs: JobSnapshot[]): void {
    if (!this.unsubscribe) return;
    this.jobs = jobs;
    this.render();
    this.delivering = this.delivering.then(() => this.deliver(jobs)).catch(() => {});
  }

  render(): void {
    if (!this.ctx.hasUI) return;
    if (!this.jobs.some(isOutstanding)) {
      this.ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    const jobs = this.jobs;
    const expanded = this.expanded;
    this.ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
      // Elapsed times in the expanded view need a clock; the compact line only changes with job state.
      const timer = expanded ? setInterval(() => tui.requestRender(), 1_000) : undefined;
      timer?.unref();
      const component: Component & { dispose(): void } = {
        render: (width) => indicatorLines(jobs, theme, width, expanded),
        invalidate() {},
        dispose() { if (timer) clearInterval(timer); },
      };
      return component;
    });
  }

  private onBranch(job: JobSnapshot): boolean {
    const anchor = job.request.owner.branchAnchor;
    return !anchor || this.ctx.sessionManager.getBranch().some((entry) => entry.id === anchor);
  }

  private async deliver(jobs: JobSnapshot[]): Promise<void> {
    const finished: JobSnapshot[] = [];
    for (const job of jobs) {
      // A notice for another branch waits until that branch is active again. Foreground
      // answers are returned by their own tool call, never announced.
      if (!isTerminal(job.status.state) || job.waitPolicy === "foreground" || job.markers.has("notified") ||
        job.markers.has("delivered") || !this.onBranch(job)) continue;
      if (await this.store.mark(job.id, "notified")) finished.push(job);
    }
    if (!finished.length || !this.unsubscribe) return;
    const details: NoticeDetails = { jobs: finished.map((job) => ({
      id: job.id, name: job.request.name, state: job.status.state, reason: job.status.terminalReason,
    })) };
    // The notice names the jobs, not their answers; the model retrieves those with subagent_jobs.
    this.pi.sendMessage({ customType: NOTICE_TYPE, content: noticeText(finished), display: true, details },
      this.mode === "passive" ? { triggerTurn: false } : { triggerTurn: true, deliverAs: this.mode });
  }
}
