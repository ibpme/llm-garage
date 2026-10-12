import { readFileSync } from "node:fs";
import type { WaitPolicy } from "../shared/agent-jobs/store.ts";

export const CONFIG_FILE = "oneshot-subagent.json";
export const NOTICE_MODES = ["followUp", "steer", "passive"] as const;
/**
 * How background completion notices reach the model. followUp: after the current run, or a new
 * turn when idle. steer: after the current tool results, or a new turn when idle. passive: append
 * only; never starts a turn.
 */
export type NoticeMode = typeof NOTICE_MODES[number];

export interface OneshotConfig {
  /** Waiting policy when a tool call omits `mode`. */
  defaultMode: WaitPolicy;
  /** Whether the send-to-background shortcut is bound; explicit background launches and /agents are unaffected. */
  allowBackgroundShortcut: boolean;
  completionNotice: NoticeMode;
}

export const DEFAULT_CONFIG: OneshotConfig = { defaultMode: "background", allowBackgroundShortcut: true, completionNotice: "followUp" };

/** Missing files and fields use the defaults; invalid values fall back per field with a warning. */
export function loadConfig(path: string): { config: OneshotConfig; warnings: string[] } {
  const config = { ...DEFAULT_CONFIG };
  const warnings: string[] = [];
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${path} is unreadable; using defaults`);
    return { config, warnings };
  }
  let value: unknown;
  try { value = JSON.parse(raw.replace(/^﻿/, "")); }
  catch { return { config, warnings: [`${path} is not valid JSON; using defaults`] }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { config, warnings: [`${path} must contain a JSON object; using defaults`] };
  const { defaultMode, allowBackgroundShortcut, completionNotice } = value as Record<string, unknown>;
  if (defaultMode === "foreground" || defaultMode === "background") config.defaultMode = defaultMode;
  else if (defaultMode !== undefined) warnings.push(`${path}: defaultMode must be "foreground" or "background"; using "${DEFAULT_CONFIG.defaultMode}"`);
  if (typeof allowBackgroundShortcut === "boolean") config.allowBackgroundShortcut = allowBackgroundShortcut;
  else if (allowBackgroundShortcut !== undefined) warnings.push(`${path}: allowBackgroundShortcut must be true or false; using ${DEFAULT_CONFIG.allowBackgroundShortcut}`);
  if (NOTICE_MODES.includes(completionNotice as NoticeMode)) config.completionNotice = completionNotice as NoticeMode;
  else if (completionNotice !== undefined) warnings.push(`${path}: completionNotice must be "followUp", "steer" or "passive"; using "${DEFAULT_CONFIG.completionNotice}"`);
  return { config, warnings };
}
