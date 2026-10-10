# figma-reader — rung 3, the REST read

`base:figma-reader` reads this file when its source ladder lands on rung 3 (no Figma MCP tool, or
a rung-1/2 call failed the way a closed app fails). Walk-through, flags and the exit table of the
script: `${CLAUDE_PLUGIN_ROOT}/references/figma-rest.md`.

One command, one `view`, then reads. The raw payloads (200 KB – 1 MB) land on disk and stay
there: never `Read` the `.nodes.json` / `.variables.json` themselves, and never paste them
anywhere.

1. **Fetch.**

   ```bash
   ${CLAUDE_PLUGIN_ROOT}/scripts/figma-rest.sh "<the Figma URL>" --out <workspace>/tmp/figma
   ```

   With no workspace path in your brief, drop `--out` — the script's own default
   (`.claude/tasks/_figma/tmp`) applies. It prints one `kind=nodes|variables|image` line per
   artifact (`status=saved|cached|unavailable|failed|skipped`, `path=`, `bytes=`) and a
   `kind=meta file_key=… node_id=… last_modified=… name=…` line (`name=` last: it is the one field
   that may carry spaces). A re-read of a node already on disk is `cached` and costs no request.
2. **Compact through slim.**

   ```text
   mcp__slim__view({ path: "<the nodes.json path>", out: "<the same path, .json → .md>" })
   ```

   slim's figma-nodes engine turns the node tree into a markdown build tree and picks up
   `<key>.variables.json` beside it on its own, so bound variables read by name; when that row
   came back `unavailable` (the plan has no Variables API), `failed` or `skipped`, the tree
   carries raw values and says so in its header. The reply opens with
   `figma-nodes: <in> B → <out> B (-NN.N%) nodes=N hidden=N folded=N` (or `cached` on a re-read),
   then `out: <path> (<n> lines)`. A refusal is one line naming why — quote it in
   `needs_clarification`.
3. **Read the compact tree** (the `out` file) — paged like the reader's original-file ladder
   when it is long (`wc -l`, sequential `Read` chunks) — **and the PNG** at the image row's
   `path`: that render is your visual ground truth, the same role `get_screenshot` plays on rungs
   1–2. An `unavailable` image row means Figma could not render it; cross-check against the tree
   alone and say so in `needs_clarification` if a judgement call depended on it.
4. **Then extract as on any other rung** — the reader's sections from *What to extract* on do not change.

Exit codes decide what you do next: `0` fine · `1` an optional artifact failed (variables or the
image download) — the node tree is still complete, **proceed** and note the gap · `2`
usage/precondition (out-dir gate, missing `curl`/`jq`) · `3` no or malformed token → rung 4 · `4`
the API rejected it (token, node, rate limit) → rung 4 · `5` transport → rung 4.
