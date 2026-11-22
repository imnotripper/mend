// main.ts is mend, the CLI SPEC.md specifies. It applies an edit an AI model wrote, in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls), to a tree of text files, changing every
// file or none of them. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// One internal shape carries every format: each format's reader turns its patch into a list of edits, each edit
// is a function over the tree, and a single matcher, applier and writer path serves them all. Line matching runs
// at three tiers (exact, trailing-whitespace-normalized, whitespace-flexible with re-indentation), and every
// changed file keeps its own line break and its final line break, unless its format says otherwise.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---- files as lines (SPEC.md section 3) ----

/** A file's lines, its own line break, and whether it ends with one. */
interface FileBuf {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileBuf {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(buf: FileBuf): string {
  if (buf.lines.length === 0) return '';
  return buf.lines.join(buf.br) + (buf.final ? buf.br : '');
}

// ---- matching lines at three tiers (SPEC.md section 5) ----

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function matchAt(lines: string[], at: number, o: string[], tier: number): boolean {
  for (let k = 0; k < o.length; k += 1) {
    if (!lineEq(tier, lines[at + k]!, o[k]!)) return false;
  }
  return true;
}

/** Every position at or after `from` where O occurs at `tier`; with `eofOnly`, only ones ending at the last line. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  const last = lines.length - o.length;
  for (let i = Math.max(from, 0); i <= last; i += 1) {
    if (eofOnly && i + o.length !== lines.length) continue;
    if (matchAt(lines, i, o, tier)) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (at or after `from`), with its positions; null when it occurs nowhere. */
function findOccurrences(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
  eofOnly: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(lines, o, tier, from, eofOnly);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line; any other line as given. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

function buildReplacement(fileLines: string[], pos: number, tier: number, o: string[], n: NewLine[]): string[] {
  const out: string[] = [];
  const f = o.length > 0 ? leadWs(fileLines[pos]!) : '';
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  for (const nl of n) {
    if (nl.ctx) {
      out.push(fileLines[pos + nl.oIndex]!);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ from: string; to: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC.md section 6) ----

interface UniHunk {
  a: number;
  o: string[];
  n: NewLine[];
  noFinal: boolean;
  noFinalPlus: boolean;
  hasPlus: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UniHunk[];
}

/** A `---`/`+++` path: up to the first tab, surrounding spaces removed, `a/`/`b/` stripped, `/dev/null` is no file. */
function patchPath(rest: string): string | null {
  const p = rest.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function buildHunk(a: number, body: string[]): UniHunk {
  const o: string[] = [];
  const n: NewLine[] = [];
  let lastCtxAdd = -1;
  let lastAdd = -1;
  for (let j = 0; j < body.length; j += 1) {
    const bl = body[j]!;
    if (bl === '') {
      o.push('');
      n.push({ text: '', ctx: true, oIndex: o.length - 1 });
      lastCtxAdd = j;
    } else if (bl[0] === ' ') {
      const t = bl.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true, oIndex: o.length - 1 });
      lastCtxAdd = j;
    } else if (bl[0] === '-') {
      o.push(bl.slice(1));
    } else if (bl[0] === '+') {
      n.push({ text: bl.slice(1), ctx: false, oIndex: -1 });
      lastCtxAdd = j;
      lastAdd = j;
    }
    // A `\` line is a body line that changes no line; it is read where the final break is decided.
  }
  const slashAfter = (j: number): boolean => j >= 0 && j + 1 < body.length && body[j + 1]!.startsWith('\\');
  return { a, o, n, noFinal: slashAfter(lastCtxAdd), noFinalPlus: slashAfter(lastAdd), hasPlus: lastAdd >= 0 };
}

/** Apply one hunk to the buffer, which it mutates; `d` is the length drift of this section's earlier hunks. */
function applyHunk(buf: FileBuf, hunk: UniHunk, d: number, strict: boolean, path: string): void {
  const lines = buf.lines;
  if (hunk.o.length === 0) {
    const at = Math.max(0, Math.min(hunk.a + d, lines.length));
    const ins = buildReplacement(lines, at, 0, [], hunk.n);
    const atEnd = at === lines.length;
    lines.splice(at, 0, ...ins);
    if (atEnd) buf.final = !hunk.noFinal;
    return;
  }
  const found = findOccurrences(lines, hunk.o, 0, strict, false);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.positions[0]!;
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const rep = buildReplacement(lines, best, found.tier, hunk.o, hunk.n);
  const toEnd = best + hunk.o.length === lines.length;
  lines.splice(best, hunk.o.length, ...rep);
  if (toEnd) buf.final = !hunk.noFinal;
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.hasPair ? sec.oldPath : sec.renameOld !== null ? sec.renameOld : sec.diffOld;
  const newP = sec.hasPair ? sec.newPath : sec.renameNew !== null ? sec.renameNew : sec.diffNew;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null) {
      // Creation: the new path does not exist; the file is the `+` lines of all its hunks.
      const np = newP!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let noFinal = false;
      for (const h of sec.hunks) {
        for (const nl of h.n) if (!nl.ctx) plus.push(nl.text);
        if (h.hasPlus) noFinal = h.noFinalPlus;
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (newP === null) {
      // Deletion: the old path exists; its hunks are not read.
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      // Move: hunks apply to the old file's lines, the result is written at the new path.
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const buf = splitFile(tree.get(oldP)!);
      let d = 0;
      for (const h of sec.hunks) {
        applyHunk(buf, h, d, strict, oldP);
        d += h.n.length - h.o.length;
      }
      tree.now.set(newP, joinFile(buf));
      tree.now.set(oldP, null);
      tree.moves.push({ from: oldP, to: newP });
      return;
    }
    // Change of the one path, which exists.
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    const buf = splitFile(tree.get(oldP)!);
    let d = 0;
    for (const h of sec.hunks) {
      applyHunk(buf, h, d, strict, oldP);
      d += h.n.length - h.o.length;
    }
    tree.now.set(oldP, joinFile(buf));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffRe = /^diff --git a\/(.+) b\/(.+)$/;
  let cur: UniSection | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = {
        oldPath: null, newPath: null, hasPair: false, renameOld: null, renameNew: null,
        diffOld: m[1]!, diffNew: m[2]!, isCreate: false, isDelete: false, hunks: [],
      };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = patchPath(line.slice(4));
      const newP = patchPath(lines[i + 1]!.slice(4));
      if (cur === null || cur.hunks.length > 0) {
        cur = {
          oldPath: oldP, newPath: newP, hasPair: true, renameOld: null, renameNew: null,
          diffOld: null, diffNew: null, isCreate: false, isDelete: false, hunks: [],
        };
        sections.push(cur);
      } else {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A lone `---` line inside a section's header is a parse error at the line after it.
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i += 1;
      const body: string[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(a, body));
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and any
      // other header line are ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    const buf = splitFile(t);
    const found = findOccurrences(buf.lines, b.oldLines, 0, strict, false);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = found.positions[0]!;
    const rep = buildReplacement(
      buf.lines,
      pos,
      found.tier,
      b.oldLines,
      b.newLines.map((text) => ({ text, ctx: false, oIndex: -1 })),
    );
    buf.lines.splice(pos, b.oldLines.length, ...rep);
    tree.now.set(p, joinFile(buf));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevReplaceEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    prevPath = path;
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: V4AChunk[];
  headerLine: number;
}

interface V4ALine {
  text: string;
  no: number;
}

function v4aEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const buf = splitFile(t);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const found = findOccurrences(buf.lines, [ch.anchor], cursor, strict, false);
        if (found === null) throw new Fail('no-match', p);
        cursor = found.positions[0]! + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? buf.lines.length : cursor;
        const ins = ch.n.map((nl) => nl.text);
        buf.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const found = findOccurrences(buf.lines, ch.o, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', p);
      const pos = found.positions[0]!;
      const rep = buildReplacement(buf.lines, pos, found.tier, ch.o, ch.n);
      buf.lines.splice(pos, ch.o.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = joinFile(buf);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, out);
      tree.now.set(p, null);
      tree.moves.push({ from: p, to: sec.moveTo });
    } else {
      tree.now.set(p, out);
    }
  };
}

function interpretV4aSection(kind: 'add' | 'delete' | 'update', path: string, raw: V4ALine[], headerLine: number): V4ASection {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const { text, no } of raw) {
      if (text.startsWith('+')) fileLines.push(text.slice(1));
      else if (text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${no}`);
    }
    return { kind, path, lines: fileLines, moveTo: null, chunks: [], headerLine };
  }
  if (kind === 'delete') {
    for (const { no } of raw) throw new Exit2(`error: parse ${no}`);
    return { kind, path, lines: [], moveTo: null, chunks: [], headerLine };
  }
  let moveTo: string | null = null;
  const chunks: V4AChunk[] = [];
  let chunk: V4AChunk | null = null;
  for (let k = 0; k < raw.length; k += 1) {
    const { text, no } = raw[k]!;
    if (text.startsWith('*** Move to: ')) {
      if (k !== 0) throw new Exit2(`error: parse ${no}`);
      moveTo = text.slice(13).trim();
      continue;
    }
    if (text.startsWith('@@')) {
      const anchor = text.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
      chunks.push(chunk);
      continue;
    }
    if (text === '*** End of File') {
      if (chunk !== null) {
        chunk.eof = true;
        chunk = null;
      }
      continue;
    }
    if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (chunk === null) {
        if (chunks.length === 0) {
          chunk = { anchor: null, eof: false, o: [], n: [] };
          chunks.push(chunk);
        } else throw new Exit2(`error: parse ${no}`);
      }
      if (text === '') {
        chunk.o.push('');
        chunk.n.push({ text: '', ctx: true, oIndex: chunk.o.length - 1 });
      } else if (text[0] === ' ') {
        const t = text.slice(1);
        chunk.o.push(t);
        chunk.n.push({ text: t, ctx: true, oIndex: chunk.o.length - 1 });
      } else if (text[0] === '-') {
        chunk.o.push(text.slice(1));
      } else {
        chunk.n.push({ text: text.slice(1), ctx: false, oIndex: -1 });
      }
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return { kind, path, lines: [], moveTo, chunks, headerLine };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    i += 1;
    const raw: V4ALine[] = [];
    while (i < end) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    sections.push(interpretV4aSection(kind, path, raw, headerLine));
  }
  return sections.map((s) => v4aEdit(s, strict));
}

// ---- invocation, output and exit codes (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: Array<{ key: string; line: string }> = [];
  const consumed = new Set<string>();
  for (const m of tree.moves) {
    if (consumed.has(m.from) || consumed.has(m.to)) continue;
    const wasFrom = tree.original(m.from);
    const nowFrom = tree.now.get(m.from);
    const wasTo = tree.original(m.to);
    const nowTo = tree.now.get(m.to);
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      entries.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      consumed.add(m.from);
      consumed.add(m.to);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (consumed.has(p)) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
