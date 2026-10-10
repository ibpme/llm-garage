import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LOADED_SKILLS_STATUS_KEY } from "../contracts/status-keys.ts";
import { loadedSkills, skillFromRead } from "./state.ts";

export default function loadedSkillsExtension(pi: ExtensionAPI) {
  let skills = new Set<string>();

  function update(ctx: ExtensionContext) {
    ctx.ui.setStatus(LOADED_SKILLS_STATUS_KEY,
      ctx.ui.theme.fg("dim", "skills: ") + ctx.ui.theme.fg("muted", [...skills].join(", ") || "none"));
  }

  function restore(ctx: ExtensionContext) {
    skills = loadedSkills(ctx.sessionManager.getBranch());
    update(ctx);
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_compact", (_event, ctx) => restore(ctx));
  pi.on("message_end", (event, ctx) => {
    // message_end runs before Pi appends this message to the session.
    const observed = loadedSkills([...ctx.sessionManager.getBranch(), {
      type: "message", id: "pending", parentId: null,
      timestamp: new Date().toISOString(), message: event.message,
    }]);
    for (const name of observed) skills.add(name);
    update(ctx);
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return;
    const name = skillFromRead(event.toolName, event.input);
    if (!name) return;
    skills.add(name);
    update(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(LOADED_SKILLS_STATUS_KEY, undefined);
  });
}
