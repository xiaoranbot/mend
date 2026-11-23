// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, in order, for the R lines of SPEC.md section 2. */
  readonly moves: { old: string; new: string }[] = [];
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

/** Split a file's text into lines, its line break and whether it ends with one (SPEC.md section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Occurrences of O in the file's lines at one tier (SPEC.md section 5). */
function occurrencesAt(fileLines: string[], o: string[], tier: number): number[] {
  const norm = tier === 0 ? (s: string): string => s : tier === 1 ? trimEndWs : trimWs;
  const out: number[] = [];
  const n = o.length;
  if (n === 0) return out;
  for (let i = 0; i + n <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (norm(fileLines[i + k]!) !== norm(o[k]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs, with its positions; null when none. */
function findTier(fileLines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(fileLines, o, t);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** First occurrence of O at or after `from`, at the first tier with one (optionally only one ending at the last line). */
function findFrom(
  fileLines: string[],
  o: string[],
  from: number,
  strict: boolean,
  eof: boolean,
): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(fileLines, o, t).filter((p) => p >= from && (!eof || p + o.length === fileLines.length));
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk. */
type BodyItem = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };

/** Split body items into O (context + old) and N (context + new); nCtx maps each N line to its O index when it is a context line. */
function splitON(body: BodyItem[]): { o: string[]; n: string[]; nCtx: (number | null)[] } {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  for (const item of body) {
    if (item.kind === 'ctx') {
      nCtx.push(o.length);
      o.push(item.text);
      n.push(item.text);
    } else if (item.kind === 'old') {
      o.push(item.text);
    } else if (item.kind === 'new') {
      nCtx.push(null);
      n.push(item.text);
    }
  }
  return { o, n, nCtx };
}

/** The N lines as written at an occurrence: a context line is the file's own matched line; other lines are re-indented at tier 2. */
function applyN(
  fileLines: string[],
  pos: number,
  o: string[],
  n: string[],
  nCtx: (number | null)[],
  tier: number,
): string[] {
  const out: string[] = [];
  const f = tier === 2 ? leadWs(fileLines[pos] ?? '') : '';
  const p = tier === 2 ? leadWs(o[0] ?? '') : '';
  for (let j = 0; j < n.length; j++) {
    const oi = nCtx[j]!;
    if (oi !== null) {
      out.push(fileLines[pos + oi]!);
    } else {
      let line = n[j]!;
      if (tier === 2 && line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(p)) line = f + line.slice(p.length);
      out.push(line);
    }
  }
  return out;
}

/** Whether a `\` line follows the hunk's last context or `+` line: then the result does not end with a line break. */
function noNewlineAfter(body: BodyItem[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const item = body[k]!;
    if (item.kind === 'ctx' || item.kind === 'new') return body[k + 1]?.kind === 'bs';
  }
  return false;
}

/** Apply a section's hunks in order to a file's text; throws Fail on a hunk that does not match. */
function applyHunks(text: string, hunks: { a: number; body: BodyItem[] }[], strict: boolean, path: string): string {
  let { lines, br, final } = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n, nCtx } = splitON(h.body);
    if (o.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      const wasEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...n, ...lines.slice(at)];
      if (wasEnd) final = !noNewlineAfter(h.body);
      d += n.length;
    } else {
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const nLines = applyN(lines, best, o, n, nCtx, found.tier);
      const touchesEnd = best + o.length === lines.length;
      lines = [...lines.slice(0, best), ...nLines, ...lines.slice(best + o.length)];
      if (touchesEnd) final = !noNewlineAfter(h.body);
      d += n.length - o.length;
    }
  }
  return joinFile(lines, br, final);
}

/** One unified-diff section (SPEC.md section 6). Paths are null for /dev/null, undefined when not named by that source. */
interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  diffOld: string;
  diffNew: string;
  isCreate: boolean;
  isDelete: boolean;
  hunks: { a: number; body: BodyItem[] }[];
}

/** The path of a `--- ` or `+++ ` header line: after the four characters, up to the first tab, trimmed; /dev/null is null; a leading a/ or b/ is removed. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function diffGitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line.trimEnd());
  if (m === null) return null;
  return [m[1]!, m[2]!];
}

function uniSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renOld !== undefined ? sec.renOld : sec.diffOld;
    const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renNew !== undefined ? sec.renNew : sec.diffNew;
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (oldPath === null && newPath === null) return;
    if (oldPath === null || sec.isCreate) {
      if (newPath === null) return;
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let lastBs = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const item = h.body[k]!;
          if (item.kind === 'new') {
            plus.push(item.text);
            lastBs = h.body[k + 1]?.kind === 'bs';
          }
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (lastBs ? '' : '\n'));
      return;
    }
    if (newPath === null || sec.isDelete) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const result = applyHunks(before, sec.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, result);
      tree.moves.push({ old: oldPath, new: newPath });
      return;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    tree.now.set(oldPath, applyHunks(before, sec.hunks, strict, oldPath));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let state: 'outside' | 'header' | 'afterHunk' = 'outside';
  let hasPair = false;
  const startSection = (pair: [string | null, string | null] | null, diff: [string, string] | null): void => {
    cur = {
      pairOld: pair === null ? undefined : pair[0],
      pairNew: pair === null ? undefined : pair[1],
      renOld: undefined,
      renNew: undefined,
      diffOld: diff === null ? '' : diff[0],
      diffNew: diff === null ? '' : diff[1],
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    sections.push(cur);
    state = 'header';
    hasPair = pair !== null;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const paths = diffGitPaths(l);
      if (paths === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(null, paths);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyItem[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') body.push({ kind: 'ctx', text: '' });
        else if (b.startsWith(' ')) body.push({ kind: 'ctx', text: b.slice(1) });
        else if (b.startsWith('-')) body.push({ kind: 'old', text: b.slice(1) });
        else if (b.startsWith('+')) body.push({ kind: 'new', text: b.slice(1) });
        else if (b.startsWith('\\')) body.push({ kind: 'bs', text: b.slice(1) });
        else break;
        j++;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') body.pop();
        else break;
      }
      cur.hunks.push({ a: Number(m[1]), body });
      state = 'afterHunk';
      i = j;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && state === 'header' && !hasPair) {
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        hasPair = true;
      } else {
        startSection([headerPath(l), headerPath(lines[i + 1]!)], null);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && state === 'header') throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && state === 'header') {
      if (l.startsWith('rename from ')) {
        if (cur.renOld === undefined) cur.renOld = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        if (cur.renNew === undefined) cur.renNew = l.slice('rename to '.length).trim();
      } else if (l.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((sec) => uniSectionEdit(sec, strict));
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const { lines, br, final } = splitFile(text);
    const found = findTier(lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const nLines = applyN(lines, pos, oldLines, newLines, newLines.map(() => null), found.tier);
    const out = [...lines.slice(0, pos), ...nLines, ...lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(out, br, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplaceEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevReplaceEnd; k--) {
      const t = lines[k]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    let eq = -1;
    for (let k = searchLine + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: an optional anchor line, whether `*** End of File` closed it, and its body lines. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyItem[];
}

function v4aEdit(
  kind: 'add' | 'delete' | 'update',
  path: string,
  moveTo: string | null,
  addLines: string[] | null,
  chunks: VChunk[] | null,
  strict: boolean,
): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (kind === 'add') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const ls = addLines!;
      tree.now.set(path, ls.length === 0 ? '' : ls.join('\n') + '\n');
      return;
    }
    if (kind === 'delete') {
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { lines, br, final } = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks!) {
      if (chunk.anchor !== null) {
        const f = findFrom(lines, [chunk.anchor], cursor, strict, false);
        if (f === null) throw new Fail('no-match', path);
        cursor = f.pos + 1;
      }
      const { o, n, nCtx } = splitON(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...n, ...lines.slice(at)];
        cursor = at + n.length;
      } else {
        const f = findFrom(lines, o, cursor, strict, chunk.eof);
        if (f === null) throw new Fail('no-match', path);
        const nLines = applyN(lines, f.pos, o, n, nCtx, f.tier);
        lines = [...lines.slice(0, f.pos), ...nLines, ...lines.slice(f.pos + o.length)];
        cursor = f.pos + nLines.length;
      }
    }
    const result = joinFile(lines, br, final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, result);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, result);
    }
  };
}

/** Parse an Update File section's raw lines (trailing blanks already removed) into its Move to and chunks. */
function parseUpdate(
  raw: { text: string; no: number }[],
  headerNo: number,
): { moveTo: string | null; chunks: VChunk[] } {
  let idx = 0;
  let moveTo: string | null = null;
  while (idx < raw.length && blank(raw[idx]!.text)) idx++;
  if (idx < raw.length && raw[idx]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[idx]!.text.slice('*** Move to: '.length).trim();
    idx++;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const closeChunk = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  while (idx < raw.length) {
    const { text, no } = raw[idx]!;
    if (blank(text)) {
      if (cur !== null) cur.body.push({ kind: 'ctx', text: '' });
      idx++;
      continue;
    }
    if (text.startsWith('@@')) {
      closeChunk();
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      idx++;
      continue;
    }
    if (text.trimEnd() === '*** End of File' && !text.startsWith(' ')) {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      closeChunk();
      idx++;
      continue;
    }
    if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (cur === null) {
        if (chunks.length === 0) {
          cur = { anchor: null, eof: false, body: [] };
        } else {
          throw new Exit2(`error: parse ${no}`);
        }
      }
      const kind = text.startsWith(' ') ? 'ctx' : text.startsWith('-') ? 'old' : 'new';
      cur.body.push({ kind, text: text.slice(1) });
      idx++;
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNo}`);
  return { moveTo, chunks };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!isStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    const headerNo = i + 1;
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const path = l.slice(l.indexOf(': ') + 2).trim();
    i++;
    const raw: { text: string; no: number }[] = [];
    while (i < last && !isStart(lines[i]!)) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') addLines.push('');
        else if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(v4aEdit('add', path, null, addLines, null, strict));
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push(v4aEdit('delete', path, null, null, null, strict));
    } else {
      const { moveTo, chunks } = parseUpdate(raw, headerNo);
      edits.push(v4aEdit('update', path, moveTo, null, chunks, strict));
    }
  }
  return edits;
}

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
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0)
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  const entries: { key: string; line: string }[] = [];
  const claimedD = new Set<string>();
  const claimedA = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.now.get(m.new);
    if (
      wasOld !== null &&
      nowOld === null &&
      wasNew === null &&
      typeof nowNew === 'string' &&
      !claimedD.has(m.old) &&
      !claimedA.has(m.new)
    ) {
      entries.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      claimedD.add(m.old);
      claimedA.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (claimedD.has(p) || claimedA.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
