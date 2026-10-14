export type Harness = 'pi' | 'claude';
export interface ProcessIdentity { pid: number; startedAt: number }
export interface ProcessInfo extends ProcessIdentity { ppid: number; command: string; args: string }
export type Runner = (command: string, args: string[]) => Promise<string>;
export type Mode = 'interactive' | 'non-interactive' | 'background' | 'unknown';
export type ActivityState = 'idle' | 'busy' | 'waiting' | 'unknown';
export interface Session { id?: string; file?: string; name?: string; cwd?: string; mode: Mode }
export interface Activity { state: ActivityState; rawState?: string; waitingFor?: string; source: 'pi-registry' | 'claude-cli' | 'claude-hook' | 'process-only'; reportedAt?: number }
export interface Model { id: string; provider?: string; displayName?: string; source: 'pi-registry' | 'claude-statusline' | 'claude-hook'; reportedAt: number }
export interface Pane { server: string; id: string; sessionId: string; sessionName: string; windowIndex: string; paneIndex: string; cwd: string }
export interface MessagingEndpoint { transport: 'unix'; path: string; protocol: 'pi-listener-v2' }
export interface AgentSnapshot { schemaVersion: 1; harness: Harness; observedAt: number; process: ProcessIdentity; session: Session; activity: Activity; model?: Model; pane?: Pane; messaging?: MessagingEndpoint & { reportedAt: number } }
export interface PublishMessage {
  version: 1; type: 'publish'; harness: Harness; process: ProcessIdentity;
  source: 'pi' | 'claude-hook' | 'claude-statusline'; reportedAt: number;
  patch: {
    messaging?: MessagingEndpoint | null;
    session?: { id?: string | null; file?: string | null; name?: string | null; cwd?: string | null; mode?: Mode };
    activity?: { state: ActivityState; rawState?: string; waitingFor?: string };
    model?: { id: string; provider?: string; displayName?: string } | null;
  };
}
export type Message = PublishMessage | { version: 1; type: 'status' } | { version: 1; type: 'stop' };
export interface DiscoveryResult { observedAt: number; processes?: Map<number, ProcessInfo>; agents: AgentSnapshot[]; errors: string[]; successfulTmuxServers: string[] }
export interface Health { version: 1; pid: number; state: 'starting' | 'running' | 'stopped'; startedAt: number; updatedAt: number; lastDiscoveryAt?: number; lastSuccessfulProcessDiscoveryAt?: number; agentCount: number; errors: string[] }
export interface Response { ok: boolean; error?: string; health?: Health }
