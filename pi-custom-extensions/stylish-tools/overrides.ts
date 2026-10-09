import type {
  BashOperations,
  EditOperations,
  FindOperations,
  GrepOperations,
  LsOperations,
  ReadOperations,
  WriteOperations,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Operations-override registry — how other extensions redirect read/write/
// edit/bash without registering their own tool of the same name.
// ---------------------------------------------------------------------------

export interface OperationsOverride {
  read?: ReadOperations;
  write?: WriteOperations;
  edit?: EditOperations;
  bash?: BashOperations;
  grep?: GrepOperations;
  ls?: LsOperations;
  find?: FindOperations;
  /** Short label shown next to the tool header/status line while active, e.g. "ssh:user@host". */
  tag?: string;
}

/**
 * Stored on globalThis, not a plain module variable: pi loads each
 * extension file through its own independent jiti import graph
 * (moduleCache: false), so another extension's own
 * `import ... from "./overrides.ts"` gets a *different* copy of this
 * module than the one pi actually invoked as the "stylish-tools"
 * extension (the one whose read/write/edit/bash tools are live). A plain
 * module-level `let` would mean setOperationsOverride() from that other
 * copy silently mutates state nobody reads. Symbol.for is the one thing
 * every copy of this module actually shares.
 */
const OPERATIONS_OVERRIDE_GLOBAL_KEY = Symbol.for("llm-garage.pi-custom-extensions.stylish-tools.operations-override");

export function getOperationsOverride(): OperationsOverride {
  return (
    ((globalThis as Record<symbol, unknown>)[OPERATIONS_OVERRIDE_GLOBAL_KEY] as OperationsOverride | undefined) ?? {}
  );
}

/** Redirect read/write/edit/bash's I/O. Pass only the ops you want to override. */
export function setOperationsOverride(next: OperationsOverride): void {
  (globalThis as Record<symbol, unknown>)[OPERATIONS_OVERRIDE_GLOBAL_KEY] = next;
}

export function clearOperationsOverride(): void {
  (globalThis as Record<symbol, unknown>)[OPERATIONS_OVERRIDE_GLOBAL_KEY] = {};
}
