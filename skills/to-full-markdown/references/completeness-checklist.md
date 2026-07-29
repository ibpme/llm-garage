# Completeness checklist — to-full-markdown

Walk this against `manifest.json` at Step 5. Every element the manifest
recorded must either appear in `<stem>.md` OR be listed in
`## Conversion notes` as intentionally dropped, WITH a reason. Any gap → go
back to Step 3/4 and recover it. Only stop when every line passes.

## Element-by-element

- [ ] **Sections / headings** — every heading in `manifest.json` is present
      in `<stem>.md` at the right level, or noted dropped.
- [ ] **Paragraphs / text** — all text content carried over; no paragraph
      silently lost. (Spot-check: source text length vs output.)
- [ ] **Lists** — every list (ordered/unordered/nested) preserved with
      items and nesting.
- [ ] **Tables** — every table present as GFM; merged-cell ranges noted;
      no table dropped or silently flattened to prose.
- [ ] **Images** — every image extracted to `<stem>.assets/` and referenced
      by relative path (no inline base64); OCR text captured or
      `ocr: skipped` noted with reason.
- [ ] **Footnotes / endnotes** — present as Markdown footnotes, or noted
      `unsupported`/`none`.
- [ ] **Comments & track-changes** — present in `## Comments & changes`,
      or noted `unsupported`/`none`.
- [ ] **Hyperlinks** — every link preserved as text + URL.
- [ ] **Captions & alt text** — preserved on their referenced element.
- [ ] **Metadata** — title/author/dates in YAML front-matter (when the
      source had them).
- [ ] **Format-specific:**
  - XLSX: every sheet present as its own `## <sheet>` section; formulas
        captured as text; merged-cell ranges noted.
  - PPTX: every slide present with number + title + body + speaker notes.
  - PDF: every page's text represented; scanned pages flagged with OCR
        status.

## Dropped-element audit
- [ ] For every entry in `manifest.json`'s `dropped` list, `## Conversion
      notes` states what it was and WHY it was dropped (cosmetic → OK per
      contract; unsupported → say so).
- [ ] Nothing was dropped silently — i.e. no source element is missing from
      both the `.md` body and the Conversion notes.

## Front-matter & audit
- [ ] YAML front-matter has `source`, `format`, `extracted` (ISO date),
      `tool`, `tool_rationale`, `metadata`, `fidelity` (ocr/comments/footnotes).
- [ ] `## Conversion notes` has: tool chosen + rationale, dropped list,
      OCR status, unsupported list, caveats.

## Final
- [ ] Images live in `<stem>.assets/` and are referenced by relative path —
      no base64 in the `.md`.
- [ ] The `.md` opens and renders (no broken table pipes, no dangling
      footnote refs, no missing image paths).
- [ ] Report to user: path to `.md` + `.assets/`, one-line Conversion-notes
      summary, any caveats.
