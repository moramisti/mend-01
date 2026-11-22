# mend

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four
formats, and mend reads each one exactly as `SPEC.md` says: a unified diff (often with wrong line
numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Every
file is changed or nothing is: when any edit of a patch fails, no file is written at all.

## Running it

Node 22, standard library only, no dependencies:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the patch file, relative to the working directory. When it is absent or is `-`, the
  patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`;
  `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code, and no file is created,
  changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Output and exit codes

Standard output holds lines, each ended by `\n`, and nothing else.

- Exit 0: one line per changed path (`A <path>`, `D <path>`, `M <path>`, or `R <old> -> <new>`
  for a move), then `ok: <n> files` (or `ok: 1 file`).
- Exit 1: one line `error: <code> <path>` per failed edit, in the patch's order, then
  `failed: <k> of <n> edits`. Nothing is written.
- Exit 2: exactly one line — `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>` — and nothing is written.

## Formats

- **Unified diffs** (`--format=unified`): sections starting at `diff --git a/<X> b/<Y>` or at a
  `--- ` / `+++ ` pair; creations, deletions, renames and moves; hunks with wrong line numbers
  (the occurrence nearest to the hunk's `A` line wins); `\ No newline at end of file` handling.
- **SEARCH/REPLACE blocks** (`--format=search-replace`): a path line, `<<<<<<< SEARCH`, old
  lines, `=======`, new lines, `>>>>>>> REPLACE`. An empty old block creates the file; an old
  block that occurs more than once at its tier is `ambiguous`.
- **V4A patches** (`--format=v4a`): `*** Begin Patch` / `*** End Patch`, `*** Add File:`,
  `*** Delete File:`, `*** Update File:` with `*** Move to:`, `@@` anchors, a cursor that moves
  past each chunk, and `*** End of File` chunks.
- **JSON edits** (`--format=json`): one JSON array of edit objects, or JSON Lines; `create`,
  `str_replace` and `insert` commands.

## Matching lines

Old lines are found at the first of three tiers at which they occur at least once: tier 0
(exact), tier 1 (trailing spaces and tabs ignored), tier 2 (leading and trailing spaces and tabs
ignored). At tier 2, new lines are re-indented to the file's indentation. `--strict` tries tier 0
only. A context line is always written as the file's own matched line, never the patch's.

## Files

- `main.ts` — the CLI. `SPEC.md` is the whole specification.
- `runner.ts` — the trial runner (kept as the kit ships it).
- `check.ts` — the practice set on your own machine:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

## License

MIT — see `LICENSE`.
