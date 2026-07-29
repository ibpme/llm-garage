---
name: to-full-markdown
description: Convert any unstructured document (HTML, PDF, DOCX, XLSX, PPTX, CSV, JSON, images, plain text) into a detail-preserving Markdown file with semantic fidelity — content, structure, relationships, and meaningful metadata; drops only cosmetic formatting. Surveys the current environment for format-specific skills/tools and prefers them, falling back to its own defaults. Use ONLY when the user explicitly runs /to-full-markdown or says "convert to full markdown" (or close variants) — do NOT auto-activate just because a file is being read, summarized, or converted to plain markdown.
compatibility: Requires uv. OCR of scanned/image-only PDFs and images requires tesseract (optional; the skill degrades gracefully without it).
---

Convert one source document into one detail-preserving Markdown file. The
goal is **semantic fidelity**: every piece of *meaning* in the source ends
up in the output, and only cosmetic formatting is dropped. This is NOT a
fire-and-forget converter — it is interactive: you recommend, then ask the
user before any heavy action, and you verify completeness before stopping.

The output is always: one `<stem>.md` file + a sibling `<stem>.assets/`
folder for extracted images/attachments, plus YAML front-matter and a
trailing `## Conversion notes` audit section (template below).

## Completeness contract (semantic fidelity)

This is the hard contract. The self-check in Step 5 enforces it.

**ALWAYS preserve**
- All text content.
- Heading hierarchy (H1–H6 inferred from style/size/numbering).
- Lists (ordered / unordered / nested).
- Tables → GFM tables; note merged-cell ranges.
- Footnotes / endnotes → Markdown footnotes.
- Comments & track-changes → a `## Comments & changes` section.
- Captions & alt text.
- Hyperlinks (text + URL).
- Spreadsheet: every sheet + its name + cell values + formulas as text + merged-cell ranges.
- Slides: title + body + speaker notes + slide number.
- Images → extract into `<stem>.assets/`, reference by relative path; OCR visible text if tesseract is available.
- Document metadata (title / author / dates) → YAML front-matter.

**DROP (cosmetic, no meaning)**
- Font family / size / color, text color, exact pixel positions, line spacing, margins, theme colors, animation, z-order.
- Header/footer chrome repeated on every page → capture once.

**CAPTURE ONLY WHEN IT CARRIES MEANING**
- bold / italic / underline / strikethrough (emphasis).
- code styling → code block.
- blockquotes → `>`.
- horizontal rules.
- text alignment inside table cells.

## Output template

````markdown
---
source: <path>
format: <pdf|docx|xlsx|pptx|html|csv|json|text|image>
extracted: <ISO-8601 date>
tool: <library/script used + version if known>
tool_rationale: <one line — why this tool, esp. if overridden from the default>
metadata:
  title: <...>
  author: <...>
  created: <...>
fidelity:
  ocr: <tesseract | skipped (tesseract not installed) | n/a>
  comments: <extracted | none | unsupported>
  footnotes: <extracted | none | unsupported>
---

# <document title or file stem>

<body — heading hierarchy, lists, GFM tables, footnotes, links, image refs>

## Comments & changes
<only if the source had comments / track-changes>

## Conversion notes
- Tool chosen: <...> — <rationale>
- Dropped: <intentionally-dropped elements + reason each>
- OCR: <what was OCR'd, or why skipped>
- Unsupported: <source elements that couldn't be represented>
- Caveats: <confidence notes>
````

## Workflow

### Step 0 — Survey your environment
Discover what's available in THIS agent, portably. Do not assume any specific
skill or tool is present.
- Read the available skills' descriptions. Note any that provide
  **format-specific extraction** (e.g. a python-docx, python-pptx, or PDF
  skill) or **current-library-doc fetching** (a context7-style skill).
- Check installed tools: `command -v tesseract pandoc libreoffice; uv --version`.

### Step 1 — Detect format & confirm scope
Identify the format (extension + content sniff).
- **In-scope** (full contract): HTML, PDF, DOCX, XLSX, PPTX, CSV, JSON, plain text, images.
- **Deferred** (best-effort + flag, or stop): RTF, ODT/ODS/ODP, EPUB, email (.eml/.msg), Visio, LaTeX, already-Markdown. For these, try `markitdown` as a fallback, set reduced-fidelity flags in Conversion notes, and stop if you can't handle it — tell the user.

### Step 2 — Explore the best tool (prefer environment → verify → defaults)
Extraction precedence:
1. If an environment skill covers THIS format → prefer it; follow its own instructions.
2. Else if an environment skill fetches current library docs (context7-style) → use it to verify the API of the library you'll use, then write an ad-hoc extractor from the defaults in `references/format-guide.md`.
3. Else → fall back to `references/format-guide.md` defaults + your own ad-hoc extractor.

Form a recommendation, then **PAUSE AND ASK THE USER** (state your recommendation, then wait) before:
- installing any system package or doing a heavy download;
- choosing between tools with a real fidelity/speed tradeoff;
- proceeding with a format you can't confidently handle.

Routine picks among uv-installable libs proceed WITHOUT asking — just note
the choice in Conversion notes.

→ Load `references/format-guide.md` now for per-format default suggestions + gotchas.

### Step 3 — Write & run an ad-hoc extractor
Write a PEP-723 inline-deps Python script and run it with `uv run` (NEVER
`pip install`, NEVER system Python). The script MUST:
- be non-interactive (all input via CLI args);
- emit TWO artifacts to a working dir: `rough.md` (mechanically extracted content) and `manifest.json` (counts + list of every element type found — sections, tables, images, footnotes, comments, metadata, links — plus a `dropped` list of source elements it couldn't represent);
- print progress to stderr, structured data to stdout.

### Step 4 — Semantic formalization pass
Using `rough.md` + `manifest.json`, apply the completeness contract: clean the
heading hierarchy, decide which formatting carries meaning, assemble the final
`<stem>.md`, extract images into a sibling `<stem>.assets/` folder referenced
by relative paths (NEVER inline base64), and write the YAML front-matter and
the trailing `## Conversion notes` from the manifest.

### Step 5 — Self-check
→ Load `references/completeness-checklist.md`. Walk it against `manifest.json`:
every element must appear in `<stem>.md` OR be accounted for in
`## Conversion notes` as intentionally dropped (with reason). Gaps → return to
Step 3/4 and recover them. Only stop when the checklist passes.

### Step 6 — Report
Tell the user the path to `<stem>.md` and `<stem>.assets/`, a one-line summary
of Conversion notes, and any caveats (e.g. OCR skipped).

## Gotchas

- **`markitdown` is a summarizing converter** — it drops comments, footnotes, document metadata, and image detail, and flattens table nuance. Use it ONLY as the fallback for deferred/unknown formats, never as the primary for in-scope formats (it violates the completeness contract).
- **`tesseract` is often not installed.** For scanned/image-only PDFs or images with embedded text, detect it; if missing, recommend (install tesseract OR proceed text-only) and ASK the user — don't silently skip and don't silently install.
- **DOCX comments / footnotes / track-changes are NOT exposed by `python-docx`.** Parse the raw OOXML (`word/comments.xml`, `word/footnotes.xml`, `word/document.xml` looking for `w:ins` / `w:del`) to recover them.
- **PDF tables:** prefer `pdfplumber` over PyMuPDF for complex/ruled tables; use PyMuPDF (`import fitz`) for text, links, images, metadata.
- **XLSX:** open with `openpyxl.load_workbook(path, data_only=False)` to capture formulas as text; record merged-cell ranges; include every sheet by name.
- **PPTX:** speaker notes live in `slide.notes_slide.notes_text_frame`, separate from slide body text — don't miss them.
- **Images:** inline base64 bloats the .md and ruins diff/review — always extract to `<stem>.assets/` and reference by relative path.
- **Always `uv run --with <libs>`** (or a PEP-723 `# /// script` block) for ad-hoc extractors. Never `pip install`.

## References
- `references/format-guide.md` — load at Step 2: non-binding per-format default extractor suggestions + per-format gotchas.
- `references/completeness-checklist.md` — load at Step 5: the self-check checklist.
