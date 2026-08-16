/**
 * The `/tools` selector.
 *
 * Edits the user's selection, not the effective tool set: while SAFE is active
 * the mode mask still wins, and a toggle made here takes visible effect on
 * /yolo. That is what keeps a selection saved during SAFE from silently
 * dropping write/edit/bash.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SettingItem,
	SettingsList,
} from "@earendil-works/pi-tui";
import type { ToolSet } from "./state.ts";

export function registerPicker(
	pi: ExtensionAPI,
	toolSet: ToolSet,
	onChange: () => void,
) {
	pi.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			const allTools = pi.getAllTools();
			const selected = new Set(toolSet.getSelection());

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const items: SettingItem[] = allTools.map((tool) => ({
					id: tool.name,
					label: tool.name,
					currentValue: selected.has(tool.name) ? "enabled" : "disabled",
					values: ["enabled", "disabled"],
				}));

				const container = new Container();
				container.addChild({
					render: () => [
						theme.fg("accent", theme.bold("Tool Configuration")),
						"",
					],
					invalidate: () => {},
				});

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 15),
					getSettingsListTheme(),
					(id, newValue) => {
						if (newValue === "enabled") {
							selected.add(id);
						} else {
							selected.delete(id);
						}
						toolSet.setSelection([...selected]);
						onChange();
					},
					() => done(undefined),
				);
				container.addChild(settingsList);

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput(data: string) {
						// Vim keys, translated to the raw sequences SettingsList expects.
						switch (data) {
							case "j":
								data = "\x1b[B";
								break; // down
							case "k":
								data = "\x1b[A";
								break; // up
							case "h":
							case "q":
								data = "\x1b";
								break; // escape / close
							case "l":
								data = " ";
								break; // space / activate
						}
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});
}
