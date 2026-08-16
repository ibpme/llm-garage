/**
 * Message content helpers.
 *
 * Stateless -- see shared/README-less note in pi-custom-extensions/README.md:
 * pi instantiates this module once per importing extension, so it must never
 * hold state.
 */

/**
 * Flatten a message's `content` into plain text, keeping only text parts.
 * Accepts the raw `unknown` shape because callers read it off session entries
 * where the part union is not narrowed.
 */
export function extractTextParts(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				!!part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}
