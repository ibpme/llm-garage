# Format guide — to-full-markdown

Non-binding default extractors + per-format gotchas. These are STARTING
SUGGESTIONS, not a mandate — verify the current API via a context7-style
doc-fetch skill (Step 2) before writing the extractor, and override per-file
when something better fits. All libraries below are uv-installable pure
Python (no system packages), so `uv run --with <libs>` works out of the box
except where OCR needs the `tesseract` binary.

For each in-scope format: default library → what to extract → gotchas.

## HTML
- **Default:** `markdownify` (BeautifulSoup-based). Fall back to raw
  `beautifulsoup4` when you need table/list nuance markdownify flattens.
- **Extract:** heading hierarchy, paragraphs, lists, tables, links (text +
  URL), images (download/extract to `<stem>.assets/`), `<blockquote>`,
  `<code>`/`<pre>`, alt text, `<title>`/`<meta>` for front-matter.
- **Gotchas:** drop nav/footer/menu chrome unless it carries content;
  preserve table cell alignment only if meaningful; decode entities; handle
  nested lists.

## PDF
- **Default:** `PyMuPDF` (`import fitz`) for text/links/images/metadata +
  `pdfplumber` for tables.
- **Extract:** text in reading order, headings (infer from font size via
  `page.get_text("dict")`), links, images (to assets/), tables, metadata
  (`doc.metadata`).
- **Gotchas:** scanned/image-only pages have NO extractable text — detect
  (`page.get_text()` empty) and OCR via `pytesseract` if tesseract is
  present (else ask the user). Multi-column layouts misorder text — use
  `get_text("blocks")` sorted by coordinates. Form fields (`doc.is_form_pdf`)
  → capture field names + values separately.

## DOCX
- **Default:** `python-docx` for structure + raw OOXML parse (via
  `zipfile` + `xml.etree`) for comments/footnotes/track-changes.
- **Extract:** paragraphs + style→heading level, runs with bold/italic,
  lists, tables (`doc.tables`), hyperlinks (`xpath` for `w:hyperlink`),
  images (from the `.docx` zip's `word/media/` → assets/), core properties
  (`doc.core_properties` for title/author/dates).
- **Gotchas:** comments live in `word/comments.xml` (not exposed by
  python-docx); footnotes in `word/footnotes.xml`; track-changes are
  `w:ins`/`w:del` in `word/document.xml`. Numbering/list style comes from
  `word/numbering.xml`. Captions are paragraphs styled `Caption`.

## XLSX
- **Default:** `openpyxl`.
- **Extract:** every sheet by name, cell values, formulas as text
  (`data_only=False`), merged-cell ranges (`ws.merged_cells.ranges`),
  header rows, sheet/row dimensions if meaningful, core properties for
  front-matter.
- **Gotchas:** `data_only=True` returns cached values (blank if the file
  was never opened in Excel) — use `data_only=False` to keep formulas, and
  note values may be unavailable. Emit each sheet as a `## <sheet name>`
  section with a GFM table; note merged cells under the table.

## PPTX
- **Default:** `python-pptx`.
- **Extract:** per slide: number, title, body text (by placeholder/shape),
  tables, images (to assets/), speaker notes
  (`slide.notes_slide.notes_text_frame.text`), hyperlinks.
- **Gotchas:** notes are a separate text frame — easy to miss. Grouped
  shapes need recursion. Slide layouts/masters are chrome — drop unless
  they carry content.

## CSV
- **Default:** stdlib `csv`.
- **Extract:** header row + rows → one GFM table. Preserve quoting/escaping
  by reading with `csv.reader`. If a column looks like JSON, render that
  cell as a nested fenced block.
- **Gotchas:** large CSVs may exceed context — if so, emit the table to the
  `.md` file directly rather than holding in memory; note row count in
  Conversion notes.

## JSON
- **Default:** stdlib `json`.
- **Extract:** pretty-print as a fenced `json` block. If it's an array of
  uniform objects, ALSO render a GFM table summary of keys as a `## Fields`
  section. Capture top-level keys as headings if the structure is a
  document-like object.
- **Gotchas:** don't silently truncate; if huge, note the size and consider
  splitting by top-level key.

## Plain text
- **Default:** none — read directly.
- **Extract:** content as-is; infer heading hierarchy from conventions
  (ALL-CAPS lines, underlines with `===`/`---`, leading numbers). Preserve
  code blocks (indented or fenced regions).
- **Gotchas:** detect encoding (`charset-normalizer` via uv) before
  decoding; don't assume UTF-8.

## Images (PNG/JPG/GIF/WEBP/BMP)
- **Default:** `pytesseract` + `Pillow` for OCR; `pillow` for metadata
  (EXIF) and to copy the image into `<stem>.assets/`.
- **Extract:** copy image to assets/, reference it in the .md, OCR any
  visible text into a fenced block under the reference, capture EXIF
  (title/author/dates) into front-matter.
- **Gotchas:** OCR needs the `tesseract` BINARY (not uv-installable). If
  missing, recommend installing it or proceeding with just the image
  reference + EXIF, and ASK the user. If the image is a photo with no text,
  OCR yields nothing — note `ocr: n/a`.

## Deferred formats (best-effort + flag, or stop)
RTF, ODT/ODS/ODP, EPUB, email (.eml/.msg), Visio, LaTeX, already-Markdown:
try `markitdown` (`uvx markitdown <file>`), set reduced-fidelity flags in
Conversion notes, and stop if fidelity is unacceptable — tell the user
rather than pretending. ODT/ODS/ODP can also be unzipped (they're OOXML-like
zips) and parsed directly if markitdown loses too much.
