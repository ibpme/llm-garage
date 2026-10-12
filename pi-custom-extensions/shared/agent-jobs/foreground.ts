// Extension import graphs are isolated; only the process-wide symbol shares the running instance.
const FOREGROUND_GLOBAL_KEY = Symbol.for("llm-garage.pi-custom-extensions.agent-jobs.foreground");
const services = globalThis as Record<symbol, unknown>;

export interface AttachedJob {
  jobId: string;
  name: string;
}

/**
 * backgrounded: the wait was released and its tool call returns a receipt.
 * completed: the job's final answer won the race and is being returned.
 * not-attached: no foreground wait for this job in this session.
 */
export type BackgroundOutcome = "backgrounded" | "completed" | "not-attached";

/** Foreground one-shot waits attached to this Pi process. */
export interface ForegroundWaits {
  /** Owned jobs whose foreground wait is still attached and unsettled, oldest first. */
  attached(owner: string): AttachedJob[];
  sendToBackground(jobId: string, owner: string): Promise<BackgroundOutcome>;
}

export function tryGetForegroundWaits(): ForegroundWaits | undefined {
  return services[FOREGROUND_GLOBAL_KEY] as ForegroundWaits | undefined;
}

export function publishForegroundWaits(waits: ForegroundWaits): () => void {
  services[FOREGROUND_GLOBAL_KEY] = waits;
  return () => {
    // An old runtime must not unregister the replacement installed by a reload.
    if (services[FOREGROUND_GLOBAL_KEY] === waits) delete services[FOREGROUND_GLOBAL_KEY];
  };
}
