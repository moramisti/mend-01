// main.ts is mend, the CLI SPEC.md specifies (MIT). It does all of SPEC.md: the command line, the output and exit
// codes, safe paths, format detection, the three-tier line matching (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file as lines: its line break, its lines, whether it ends with a line break (SPEC.md section 3). */
interface FileDoc {
  br: string;
  lines: string[];
  final: boolean;
}

function parseDoc(text: string): FileDoc {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers.                           */
/* ------------------------------------------------------------------ */

const stripTrailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function lineEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripWs(a) === stripWs(b);
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions i (at or after `from`) where O matches lines[i .. i+O.length-1] at `tier`; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(tier, o[k]!, lines[i + k]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** One line of N: its text, and the index into O of the context line it repeats (-1: a new line). */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * The lines N writes when O matched the file's lines at `pos` at `tier`: a context line is written as the
 * file's own matched line; at tier 2 every other line is re-indented (O's first line's leading spaces and tabs
 * replaced by the file's first matched line's); otherwise the lines are written as they are.
 */
function buildN(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const f = o.length > 0 ? leadingWs(fileLines[pos]!) : '';
  for (const l of n) {
    if (l.ctx >= 0) {
      out.push(fileLines[pos + l.ctx]!);
      continue;
    }
    if (tier === 2 && l.text !== '' && !/^[ \t]+$/.test(l.text) && l.text.startsWith(p)) out.push(f + l.text.slice(p.length));
    else out.push(l.text);
  }
  return out;
}

/** One body line of a unified hunk or a V4A chunk. `rawEmpty` is true when the patch line itself was empty. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNl: boolean;
  rawEmpty: boolean;
}

/** Split body lines into O's lines and N's lines, keeping the context correspondence. */
function splitBody(body: BodyLine[]): { o: string[]; n: NLine[]; lastCtxOrNew: BodyLine | null } {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxOrNew: BodyLine | null = null;
  for (const b of body) {
    if (b.kind === 'ctx') {
      const oPos = o.length;
      o.push(b.text);
      n.push({ text: b.text, ctx: oPos });
      lastCtxOrNew = b;
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else {
      n.push({ text: b.text, ctx: -1 });
      lastCtxOrNew = b;
    }
  }
  return { o, n, lastCtxOrNew };
}

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

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs.                                           */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  /** Paths from the `diff --git` line (null when the section did not start with one). */
  diffOld: string | null;
  diffNew: string | null;
  /** Paths from a `---` / `+++` pair (undefined: no pair yet; null: `/dev/null`). */
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  /** Paths from `rename from` / `rename to` (undefined: none). */
  renameOld: string | undefined;
  renameNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The section's old and new path: the `---` / `+++` pair names them, else `rename from` / `rename to`, else
 *  the `diff --git` paths. */
function sectionPaths(sec: UniSection): { oldPath: string | null; newPath: string | null } {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld;
  const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew;
  return { oldPath, newPath };
}

/** `diff --git a/<X> b/<Y>`, or null when the line is not of that form. */
function parseDiffGit(line: string): [string, string] | null {
  if (!line.startsWith('diff --git a/')) return null;
  const rest = line.slice('diff --git a/'.length);
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(0, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

/** The path of a `--- ` / `+++ ` header line: text after the four characters, up to the first tab, surrounding
 *  spaces removed; `/dev/null` is null; a leading `a/` or `b/` is removed. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unifiedEdits(lines: string[], strict: boolean, recordMove: (oldP: string, newP: string) => void): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const p = parseDiffGit(line);
      if (p === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: p[0], diffNew: p[1], pairOld: undefined, pairNew: undefined, renameOld: undefined, renameNew: undefined, create: false, del: false, hunks: [] };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          hunk.body.push({ kind: 'ctx', text: '', noNl: false, rawEmpty: true });
          j += 1;
        } else if (bl[0] === ' ') {
          hunk.body.push({ kind: 'ctx', text: bl.slice(1), noNl: false, rawEmpty: false });
          j += 1;
        } else if (bl[0] === '-') {
          hunk.body.push({ kind: 'old', text: bl.slice(1), noNl: false, rawEmpty: false });
          j += 1;
        } else if (bl[0] === '+') {
          hunk.body.push({ kind: 'new', text: bl.slice(1), noNl: false, rawEmpty: false });
          j += 1;
        } else if (bl[0] === '\\') {
          if (hunk.body.length > 0) hunk.body[hunk.body.length - 1]!.noNl = true;
          j += 1;
        } else break;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.rawEmpty && !last.noNl) hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) {
        // Part of this section's header; the first pair names the paths.
        if (cur.pairOld === undefined) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(lines[i + 1]!);
        }
      } else {
        cur = { diffOld: null, diffNew: null, pairOld: headerPath(line), pairNew: headerPath(lines[i + 1]!), renameOld: undefined, renameNew: undefined, create: false, del: false, hunks: [] };
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Inside the section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        if (cur.pairNew === undefined) cur.pairNew = headerPath(line);
      } else if (line.startsWith('rename from ')) {
        if (cur.renameOld === undefined) cur.renameOld = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (cur.renameNew === undefined) cur.renameNew = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.create = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.del = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:` and any other
      // line are ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored (prose, code fences).
    i += 1;
  }
  return sections.map((sec) => unifiedEdit(sec, strict, recordMove));
}

/** Apply a section's hunks, in order, to a file's text. `path` is the file the failure concerns. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  let doc = parseDoc(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n, lastCtxOrNew } = splitBody(h.body);
    if (o.length === 0) {
      const oldLen = doc.lines.length;
      const pos = Math.min(Math.max(h.a + d, 0), oldLen);
      const texts = n.map((l) => l.text);
      if (texts.length === 0) continue;
      let fin = doc.final;
      if (pos === oldLen) fin = !(lastCtxOrNew !== null && lastCtxOrNew.noNl);
      doc = { br: doc.br, lines: [...doc.lines.slice(0, pos), ...texts, ...doc.lines.slice(pos)], final: fin };
      d += texts.length;
      continue;
    }
    let found: { tier: number; pos: number } | null = null;
    for (const tier of tiers(strict)) {
      const occ = occurrences(doc.lines, o, tier);
      if (occ.length === 0) continue;
      const target = h.a - 1 + d;
      let best = occ[0]!;
      for (const p of occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      found = { tier, pos: best };
      break;
    }
    if (found === null) throw new Fail('no-match', path);
    const finalN = buildN(doc.lines, found.pos, o, n, found.tier);
    const runsToEnd = found.pos + o.length === doc.lines.length;
    let fin = doc.final;
    if (runsToEnd) fin = !(lastCtxOrNew !== null && lastCtxOrNew.noNl);
    doc = { br: doc.br, lines: [...doc.lines.slice(0, found.pos), ...finalN, ...doc.lines.slice(found.pos + o.length)], final: fin };
    d += finalN.length - o.length;
  }
  return doc;
}

function unifiedEdit(sec: UniSection, strict: boolean, recordMove: (oldP: string, newP: string) => void): Edit {
  const { oldPath, newPath } = sectionPaths(sec);
  return (tree) => {
    const paths: string[] = [];
    if (oldPath !== null) paths.push(oldPath);
    if (newPath !== null) paths.push(newPath);
    for (const p of paths) {
      if (!safe(p)) throw new Fail('unsafe', p);
    }
    const isCreate = oldPath === null || sec.create;
    const isDelete = !isCreate && (newPath === null || sec.del);
    if (isCreate) {
      const np = newPath;
      if (np === null) throw new Fail('unsafe', '');
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const lines: string[] = [];
      let lastPlus: BodyLine | null = null;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') {
            lines.push(b.text);
            lastPlus = b;
          }
        }
      }
      tree.now.set(np, renderDoc({ br: '\n', lines, final: !(lastPlus !== null && lastPlus.noNl) }));
      return;
    }
    if (isDelete) {
      const op = oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldPath !== newPath) {
      const op = oldPath!;
      const np = newPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const doc = applyHunks(tree.get(op)!, sec.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, renderDoc(doc));
      recordMove(op, np);
      return;
    }
    const p = oldPath!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const doc = applyHunks(before, sec.hunks, strict, p);
    tree.now.set(p, renderDoc(doc));
  };
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks.                                   */
/* ------------------------------------------------------------------ */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let j = i + 1;
    while (j < n && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= n) throw new Exit2(`error: parse ${searchLine}`);
    let k = j + 1;
    while (k < n && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= n) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, j), lines.slice(j + 1, k), strict));
    prevPath = path;
    prevReplace = k;
    i = k + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = parseDoc(before);
    let found: { tier: number; pos: number } | null = null;
    for (const tier of tiers(strict)) {
      const occ = occurrences(doc.lines, oldLines, tier);
      if (occ.length === 0) continue;
      if (occ.length > 1) throw new Fail('ambiguous', path);
      found = { tier, pos: occ[0]! };
      break;
    }
    if (found === null) throw new Fail('no-match', path);
    const n: NLine[] = newLines.map((text) => ({ text, ctx: -1 }));
    const finalN = buildN(doc.lines, found.pos, oldLines, n, found.tier);
    const out: FileDoc = {
      br: doc.br,
      lines: [...doc.lines.slice(0, found.pos), ...finalN, ...doc.lines.slice(found.pos + oldLines.length)],
      final: doc.final,
    };
    tree.now.set(path, renderDoc(out));
  };
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches.                                             */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
}

function v4aSectionStart(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (line.startsWith('*** Add File: ')) return { kind: 'add', path: line.slice(14).trim() };
  if (line.startsWith('*** Delete File: ')) return { kind: 'delete', path: line.slice(17).trim() };
  if (line.startsWith('*** Update File: ')) return { kind: 'update', path: line.slice(17).trim() };
  return null;
}

function v4aEdits(lines: string[], strict: boolean, recordMove: (oldP: string, newP: string) => void): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Raw {
    kind: 'add' | 'delete' | 'update';
    path: string;
    headerLine: number;
    raw: Array<{ text: string; no: number }>;
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    const no = i + 1;
    const start = v4aSectionStart(line);
    if (start !== null) {
      if (cur !== null) raws.push(cur);
      cur = { kind: start.kind, path: start.path, headerLine: no, raw: [] };
      continue;
    }
    if (cur === null) {
      if (!blank(line)) throw new Exit2(`error: parse ${no}`);
      continue;
    }
    cur.raw.push({ text: line, no });
  }
  if (cur !== null) raws.push(cur);
  const sections: V4ASection[] = [];
  for (const s of raws) {
    // Blank lines at the end of a section are not part of it.
    while (s.raw.length > 0 && blank(s.raw[s.raw.length - 1]!.text)) s.raw.pop();
    if (s.kind === 'add') {
      const addLines: string[] = [];
      for (const r of s.raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      sections.push({ kind: 'add', path: s.path, headerLine: s.headerLine, moveTo: null, addLines, chunks: [] });
    } else if (s.kind === 'delete') {
      for (const r of s.raw) throw new Exit2(`error: parse ${r.no}`);
      sections.push({ kind: 'delete', path: s.path, headerLine: s.headerLine, moveTo: null, addLines: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (s.raw.length > 0 && s.raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = s.raw[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: V4AChunk[] = [];
      let chunk: V4AChunk | null = null;
      const close = (): void => {
        if (chunk !== null) {
          chunks.push(chunk);
          chunk = null;
        }
      };
      for (; idx < s.raw.length; idx++) {
        const r = s.raw[idx]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          close();
          const anchor = t.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          continue;
        }
        if (t === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${r.no}`);
          chunk.eof = true;
          close();
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (chunk === null) chunk = { anchor: null, eof: false, body: [] };
          if (t === '') chunk.body.push({ kind: 'ctx', text: '', noNl: false, rawEmpty: true });
          else if (t[0] === ' ') chunk.body.push({ kind: 'ctx', text: t.slice(1), noNl: false, rawEmpty: false });
          else if (t[0] === '-') chunk.body.push({ kind: 'old', text: t.slice(1), noNl: false, rawEmpty: false });
          else chunk.body.push({ kind: 'new', text: t.slice(1), noNl: false, rawEmpty: false });
          continue;
        }
        throw new Exit2(`error: parse ${r.no}`);
      }
      close();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.headerLine}`);
      sections.push({ kind: 'update', path: s.path, headerLine: s.headerLine, moveTo, addLines: [], chunks });
    }
  }
  return sections.map((sec) => v4aEdit(sec, strict, recordMove));
}

function v4aEdit(sec: V4ASection, strict: boolean, recordMove: (oldP: string, newP: string) => void): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let doc = parseDoc(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let foundLine = -1;
        for (const tier of tiers(strict)) {
          for (let j = cursor; j < doc.lines.length; j++) {
            if (lineEq(tier, chunk.anchor, doc.lines[j]!)) {
              foundLine = j;
              break;
            }
          }
          if (foundLine >= 0) break;
        }
        if (foundLine < 0) throw new Fail('no-match', sec.path);
        cursor = foundLine + 1;
      }
      const { o, n } = splitBody(chunk.body);
      if (o.length === 0) {
        const pos = chunk.eof ? doc.lines.length : cursor;
        const texts = n.map((l) => l.text);
        doc = { br: doc.br, lines: [...doc.lines.slice(0, pos), ...texts, ...doc.lines.slice(pos)], final: doc.final };
        cursor = pos + texts.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      for (const tier of tiers(strict)) {
        const occ = occurrences(doc.lines, o, tier, cursor);
        const cand = chunk.eof ? occ.filter((p) => p + o.length === doc.lines.length) : occ;
        if (cand.length === 0) continue;
        found = { tier, pos: cand[0]! };
        break;
      }
      if (found === null) throw new Fail('no-match', sec.path);
      const finalN = buildN(doc.lines, found.pos, o, n, found.tier);
      doc = { br: doc.br, lines: [...doc.lines.slice(0, found.pos), ...finalN, ...doc.lines.slice(found.pos + o.length)], final: doc.final };
      cursor = found.pos + finalN.length;
    }
    const out = renderDoc(doc);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      recordMove(sec.path, sec.moveTo);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Section 1, 2 and 10: invocation, output, exit codes, order.        */
/* ------------------------------------------------------------------ */

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
  const moves: Array<{ old: string; new: string }> = [];
  const recordMove = (oldP: string, newP: string): void => {
    moves.push({ old: oldP, new: newP });
  };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, recordMove)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict, recordMove);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Every state read below happens before any file is written.
  const changed = [...tree.now.keys()]
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
    .filter((p) => tree.original(p) !== tree.now.get(p));
  const rows: Array<{ key: string; line: string }> = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      rOld.add(m.old);
      rNew.add(m.new);
    }
  }
  for (const p of changed) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const linesOut = rows.map((r) => r.line);
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...linesOut, `ok: ${linesOut.length} ${linesOut.length === 1 ? 'file' : 'files'}`] };
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
