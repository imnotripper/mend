[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/imnotripper/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/imnotripper/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

`mend` is one command-line tool that applies an edit an AI model wrote to a tree of text files. Models write edits
in four formats, and `mend` reads each one exactly as `SPEC.md` says — then changes every file, or none of them.

| Format | What it looks like | How it is read |
| --- | --- | --- |
| `unified` | `diff --git`, `---`/`+++`, `@@ -A,B +C,D @@` hunks | Sections are single edits (change, create, delete, move); hunks apply in order, nearest to their stated line number |
| `search-replace` | `<path>` + `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` | One block is one edit; old lines must occur exactly once at their tier |
| `v4a` | `*** Begin Patch` … `*** End Patch` | Add / Delete / Update sections; chunks walk a cursor, `@@` anchors and `*** End of File` pin them |
| `json` | one edit object per line, or a JSON array | `create`, `str_replace`, `insert` tool calls; exact text matching, no tiers |

## CLI contract

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file, or `-` / absent for standard input.
- `--format=NAME` is `auto` (default), `unified`, `search-replace`, `v4a` or `json`. `auto` detects the format.
- `--check` does everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order; `--` ends the options.

Exit codes and output:

- Exit 2, one line: `error: usage`, `error: no-patch`, `error: format`, or `error: parse <N>`.
- Exit 1: one `error: <code> <path>` line per failed edit, in patch order, then `failed: <k> of <n> edits`.
  Codes: `no-match`, `ambiguous`, `missing`, `exists`, `unsafe`. No file is written.
- Exit 0: one line per changed path, in byte order — `A <path>`, `D <path>`, `M <path>`, or
  `R <old> -> <new>` for a move — then `ok: <n> files` (`ok: 1 file` when n is 1). A patch that changes
  nothing prints only `ok: 0 files`.

## How it works

One internal edit shape carries every format: each format's reader turns its patch into a list of edits, and a
single matcher, applier and writer path serves them all.

- **Matcher ladder (SPEC §5).** Old lines are found at the first tier where they occur at least once: tier 0
  (every line equal), tier 1 (trailing spaces/tabs ignored), tier 2 (leading and trailing spaces/tabs ignored).
  At tier 2, added lines are re-indented from the old block's leading whitespace to the file's. Context lines are
  always written as the file's own matched line, never the patch's, so a file's trailing whitespace and
  indentation survive an edit. Unified hunks take the occurrence nearest their stated line number (adjusted for
  earlier hunks); SEARCH/REPLACE blocks refuse loudly with `ambiguous` when the old lines occur more than once;
  V4A chunks take the first occurrence at or after a cursor that walks the file.
- **Fidelity.** A changed file keeps its own line break (CRLF or LF) and its final line break, unless a unified
  hunk's `\ No newline at end of file` says otherwise. Created files use LF and end with a line break. A JSON
  `create` writes its `file_text` byte for byte.
- **Atomicity.** Edits apply in patch order to the tree as earlier edits left it. Every path an edit names is
  checked for safety (no empty, absolute, backslash or `.`/`..` segments) before anything else about it. A failed
  edit changes nothing and the edits after it still run, so every failure is reported; when any edit failed, no
  file is written at all. Writes go through the in-memory tree and land only on exit 0 without `--check`.

## Files

- `main.ts` — the CLI. Node 22, standard library only, zero dependencies.
- `runner.ts` — the kit's trial runner (kept as-is): runs `main.ts` on each check in a fresh directory.
- `check.ts` — the practice-set runner on your own machine.
- `SPEC.md` — the whole specification (version 1).

## Running the practice checks

The kit carries the practice set at `program/generator/practice.json` (100 checks: unified 30, search-replace 20,
V4A 20, JSON 15, CLI 15):

    node check.ts <path to practice.json>
    node check.ts <path to practice.json> u-offset s-basic

It prints every check that does not match, with what differed, then the practice score
(`round(1000 x passed / checks)`).

## Verification

Practice set, local run: **100 of 100 passed, practice score 1000** (unified 30/30, search-replace 20/20,
V4A 20/20, JSON 15/15, CLI 15/15). The one failure found on the first run — a V4A chunk whose trailing
whitespace-only line was kept as a context line — is fixed by trimming trailing blank lines (empty or only
whitespace, SPEC §4's definition of blank) from a V4A section before reading it; the same run also probed
spec corners the practice set does not cover (creation without a final line break, `\` after a `-` line only,
hunk-less moves, move-only V4A sections, nearest-tie hunks, chained moves, CRLF without a final break).
