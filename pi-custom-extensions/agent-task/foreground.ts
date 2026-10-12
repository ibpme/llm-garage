import type { AttachedJob, BackgroundOutcome, ForegroundWaits } from "../shared/agent-jobs/foreground.ts";

export type Settlement = "completed" | "background" | "cancelled";

/** One foreground tool call waiting on its supervised job. */
export class AttachedWait {
  readonly jobId: string;
  readonly name: string;
  readonly owner: string;
  settled?: Settlement;
  /** Runs once the wait is claimed for background, before the tool call is woken. */
  onBackground: () => Promise<void> = async () => {};
  private wakeUp!: () => void;
  wake!: Promise<void>;

  constructor(job: { jobId: string; name: string; owner: string }) {
    this.jobId = job.jobId;
    this.name = job.name;
    this.owner = job.owner;
    this.rearm();
  }

  private rearm(): void {
    this.wake = new Promise((resolve) => { this.wakeUp = resolve; });
  }

  notify(): void {
    const wakeUp = this.wakeUp;
    this.rearm();
    wakeUp();
  }

  /**
   * Claims the wait's outcome synchronously; the first claim wins, so a release
   * and a completion observed in the same tick can never both be returned.
   */
  settle(kind: Settlement): boolean {
    if (this.settled) return false;
    this.settled = kind;
    return true;
  }
}

export class AttachedWaits implements ForegroundWaits {
  private readonly waits = new Map<string, AttachedWait>();

  attach(job: { jobId: string; name: string; owner: string }): AttachedWait {
    const wait = new AttachedWait(job);
    this.waits.set(job.jobId, wait);
    return wait;
  }

  detach(wait: AttachedWait): void {
    if (this.waits.get(wait.jobId) === wait) this.waits.delete(wait.jobId);
  }

  get all(): AttachedWait[] { return [...this.waits.values()]; }

  attached(owner: string): AttachedJob[] {
    return this.all.filter((wait) => wait.owner === owner && !wait.settled).map(({ jobId, name }) => ({ jobId, name }));
  }

  async sendToBackground(jobId: string, owner: string): Promise<BackgroundOutcome> {
    const wait = this.waits.get(jobId);
    if (!wait || wait.owner !== owner) return "not-attached";
    if (!wait.settle("background")) return wait.settled === "background" ? "backgrounded" : wait.settled === "completed" ? "completed" : "not-attached";
    try { await wait.onBackground(); }
    finally { wait.notify(); }
    return "backgrounded";
  }
}
