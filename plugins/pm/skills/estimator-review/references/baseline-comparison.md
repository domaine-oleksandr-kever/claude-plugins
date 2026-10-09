# Baseline Comparison

Domaine maintains baseline estimator templates in Google Drive. Use one as a reference when the
estimate under review looks unusually thin or fat for its type, or when a standard line item seems
missing. **Always fetch fresh** — baselines update semi-regularly; never trust a cached or local
copy.

Fetching one needs a Google Drive tool. When such a tool is present in this session, use the access
pattern below; otherwise ask the SE for a current export of the baseline, or skip the comparison and
say in the output that no baseline was consulted and why.

## When to consult a baseline

Don't fetch one by default — most reviews don't need it. Pull a baseline when:

- The estimate looks unusually thin or fat for its project type and you want to confirm against
  standard scope.
- A line item or assumption seems missing and you want to confirm whether it's standard.
- Role coverage looks off and you want to compare the role mix against the template defaults.
- The user explicitly asks for a comparison.

Baseline comparison is informational. Only surface a baseline finding when it translates into a
concrete change the author should make before submitting.

## Default baseline

For most projects, the general-purpose Online Store baseline is the right reference.

- **Name:** `[Domaine NA _ Client Name] x Domaine - Project Estimator [Online Store Baseline]`
- **Where:** the estimating lead's Drive folder; its file id is not in this plugin. Find it by the
  name above (the Drive search below), or ask the user for the link.

## Project-type-specific baselines

Different variants use different templates — Multi-site, Multi-brand, B2B, POS, PCR, Build 2.0,
and others. Match the baseline to the variant tag on the estimate under review (see
`estimator-structure.md`).

Search Drive (the Drive tool's `search_files`, or its equivalent) using queries like:

- `title contains 'Project Estimator' and title contains 'Baseline'`
- `title contains 'Project Estimator' and title contains '_template_'`
- `title contains 'Project Estimator [<variant>'`

Filter for `mimeType = 'application/vnd.google-apps.spreadsheet'`. Skip anything prefixed
`RETIRED`, `DO NOT USE`, `WIP`, or `INTERNAL_COPY`.

If you can't confidently identify the right variant baseline, fall back to the Online Store
baseline and say in the output which baseline was used and that the match was uncertain.

## Access pattern

### Option A — text representation (faster, lighter)

`read_file_content` with the baseline's `fileId`. Returns a natural-language representation of the
sheet. Good enough for cross-checking assumptions, line-item names, or section structure.

If the response exceeds the inline token limit, the MCP saves full content to a temp file and
returns the path. Read it in chunks.

### Option B — full .xlsx parse (structured comparison)

`download_file_content` with the baseline's `fileId` and
`exportMimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'`.

The bytes usually exceed the inline budget, so the response includes a temp path. From there:

1. The temp file holds a JSON envelope with the binary content, typically base64.
2. Decode and write the `.xlsx` to a working directory.
3. Open with `openpyxl.load_workbook(path, data_only=True)` when a Python with `openpyxl` is present
   in this session; otherwise fall back to Option A and say the structured parse was not available.

Generate this inline as a short bash + Python sequence rather than relying on a bundled script.

**Read the baseline for scope structure, line items, assumptions, and role mix only.** Ignore its
rate card, price, cost, and margin columns — those are out of scope for this review.
