// main.ts is mend, the CLI SPEC.md specifies (version 1). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`. Implements all of SPEC.md: sections 1-4 (command line, output and exit
// codes, safe paths, format detection), 5 (three-tier line matching), 6 (unified diffs), 7 (SEARCH/REPLACE
// blocks), 8 (V4A patches), 9 (JSON edits) and 10 (order and atomicity).
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

/** An edit: applies itself to the tree, throwing Fail on failure. Returns a move pair when it moves a file. */
type Edit = (tree: Tree) => [string, string] | void;

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

// ---- Section 3: files, lines ----

interface FileParts {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

// ---- Section 5: matching lines ----

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

const TRANSFORMS: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

function tiersFor(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions i (>= from) where O matches lines, at one tier; eofOnly keeps only occurrences ending at the last line. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const t = TRANSFORMS[tier]!;
  const out: number[] = [];
  const last = lines.length - o.length;
  for (let i = from; i <= last; i++) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (t(lines[i + j]!) !== t(o[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (in order) at which O occurs at least once, with its positions, or null. */
function findTier(lines: string[], o: string[], tiers: number[], from: number, eofOnly: boolean): { tier: number; positions: number[] } | null {
  for (const tier of tiers) {
    const positions = occurrences(lines, o, tier, from, eofOnly);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** First line at or after `from` equal to a single-line anchor, at the first tier where one is, or null. */
function findAnchor(lines: string[], anchor: string, tiers: number[], from: number): number | null {
  for (const tier of tiers) {
    const t = TRANSFORMS[tier]!;
    for (let i = from; i < lines.length; i++) {
      if (t(lines[i]!) === t(anchor)) return i;
    }
  }
  return null;
}

interface NEntry {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Build the lines replacing O at pos: context lines are the file's own matched lines; at tier 2 the other
 * lines of N are re-indented from O's first line's leading whitespace to the file's first matched line's. */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: NEntry[], tier: number): string[] {
  if (o.length === 0) return n.map((e) => e.text);
  const f = leadingWs(fileLines[pos]!);
  const p = leadingWs(o[0]!);
  return n.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIdx]!;
    if (tier !== 2) return e.text;
    if (e.text === '' || /^[ \t]*$/.test(e.text)) return e.text;
    if (!e.text.startsWith(p)) return e.text;
    return f + e.text.slice(p.length);
  });
}

// ---- Section 6: unified diffs ----

type BodyKind = 'ctx' | 'del' | 'add' | 'bs';
interface BodyLine {
  kind: BodyKind;
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  diffOld: string | null;
  diffNew: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  pairSeen: boolean;
  renameOld: string | null;
  renameNew: string | null;
  createFlag: boolean;
  delFlag: boolean;
  hunks: Hunk[];
}

function emptySection(): Section {
  return { diffOld: null, diffNew: null, hdrOld: null, hdrNew: null, pairSeen: false, renameOld: null, renameNew: null, createFlag: false, delFlag: false, hunks: [] };
}

/** The path of a `--- ` / `+++ ` header line: text after the four characters, up to the first tab,
 * surrounding spaces removed, `/dev/null` meaning no file, a leading `a/` or `b/` removed. */
function headerPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

/** Split a hunk body into its old lines O and new lines N (with context flags), plus whether a `\` line
 * follows the hunk's last context or `+` line (null when the hunk has no context or `+` line). */
function bodyON(body: BodyLine[]): { o: string[]; n: NEntry[]; lastNBs: boolean | null } {
  const o: string[] = [];
  const n: NEntry[] = [];
  let lastNBs: boolean | null = null;
  body.forEach((b, idx) => {
    const bsAfter = idx + 1 < body.length && body[idx + 1]!.kind === 'bs';
    if (b.kind === 'ctx') {
      n.push({ text: b.text, ctx: true, oIdx: o.length });
      o.push(b.text);
      lastNBs = bsAfter;
    } else if (b.kind === 'del') {
      o.push(b.text);
    } else if (b.kind === 'add') {
      n.push({ text: b.text, ctx: false, oIdx: -1 });
      lastNBs = bsAfter;
    }
  });
  return { o, n, lastNBs };
}

/** Apply a section's hunks in order to a file's text, following section 6's offset, nearest-position,
 * insertion and final-break rules. Throws Fail('no-match', path) when a hunk's O is not found. */
function applyHunks(fileText: string, hunks: Hunk[], path: string, strict: boolean): string {
  const tiers = tiersFor(strict);
  const fp = splitFile(fileText);
  const lines = fp.lines;
  let finalBreak = fp.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const { o, n, lastNBs } = bodyON(h.body);
    if (o.length === 0) {
      const insertPos = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = insertPos === lines.length;
      const rep = buildReplacement(lines, insertPos, o, n, 0);
      lines.splice(insertPos, 0, ...rep);
      if (atEnd) finalBreak = !(lastNBs ?? false);
      d += n.length;
    } else {
      const found = findTier(lines, o, tiers, 0, false);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      for (const q of found.positions) {
        if (Math.abs(q - target) < Math.abs(pos - target)) pos = q;
      }
      const runsToEnd = pos + o.length === lines.length;
      const rep = buildReplacement(lines, pos, o, n, found.tier);
      lines.splice(pos, o.length, ...rep);
      if (runsToEnd) finalBreak = !(lastNBs ?? false);
      d += n.length - o.length;
    }
  }
  return joinFile(lines, fp.br, finalBreak);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur !== null) sections.push(cur);
      cur = emptySection();
      cur.diffOld = m[1]!.trim();
      cur.diffNew = m[2]!.trim();
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && cur.hunks.length === 0 && !cur.pairSeen) {
        cur.hdrOld = oldP;
        cur.hdrNew = newP;
        cur.pairSeen = true;
      } else {
        if (cur !== null) sections.push(cur);
        cur = emptySection();
        cur.hdrOld = oldP;
        cur.hdrNew = newP;
        cur.pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ \t].*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '' });
          j++;
        } else if (bl.startsWith(' ')) {
          body.push({ kind: 'ctx', text: bl.slice(1) });
          j++;
        } else if (bl.startsWith('-')) {
          body.push({ kind: 'del', text: bl.slice(1) });
          j++;
        } else if (bl.startsWith('+')) {
          body.push({ kind: 'add', text: bl.slice(1) });
          j++;
        } else if (bl.startsWith('\\')) {
          body.push({ kind: 'bs', text: bl });
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a, body });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.createFlag = true;
      else if (line.startsWith('deleted file mode')) cur.delFlag = true;
      i++;
      continue;
    }
    i++;
  }
  if (cur !== null) sections.push(cur);

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.pairSeen ? s.hdrOld : (s.renameOld ?? s.diffOld);
    const newP = s.pairSeen ? s.hdrNew : (s.renameNew ?? s.diffNew);
    const hunks = s.hunks;
    const checkPaths = (): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    };
    if (oldP === null && newP === null) {
      edits.push(() => {});
      continue;
    }
    if ((s.createFlag || oldP === null) && newP !== null) {
      const newPath = newP;
      edits.push((tree) => {
        checkPaths();
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const addLines: string[] = [];
        let noBreak = false;
        for (const h of hunks) {
          for (let k = 0; k < h.body.length; k++) {
            const b = h.body[k]!;
            if (b.kind === 'add') {
              addLines.push(b.text);
              noBreak = k + 1 < h.body.length && h.body[k + 1]!.kind === 'bs';
            }
          }
        }
        tree.now.set(newPath, addLines.length === 0 ? '' : addLines.join('\n') + (noBreak ? '' : '\n'));
      });
      continue;
    }
    if ((s.delFlag || newP === null) && oldP !== null) {
      const oldPath = oldP;
      edits.push((tree) => {
        checkPaths();
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      });
      continue;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const oldPath = oldP;
      const newPath = newP;
      edits.push((tree) => {
        checkPaths();
        const curText = tree.get(oldPath);
        if (curText === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const result = applyHunks(curText, hunks, oldPath, strict);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, result);
        return [oldPath, newPath] as [string, string];
      });
      continue;
    }
    if (oldP !== null && newP !== null) {
      const path = oldP;
      edits.push((tree) => {
        checkPaths();
        const curText = tree.get(path);
        if (curText === null) throw new Fail('missing', path);
        tree.now.set(path, applyHunks(curText, hunks, path, strict));
      });
      continue;
    }
    edits.push(() => {});
  }
  return edits;
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let cursor = 0;
  let prevPath: string | null = null;
  for (;;) {
    let s = -1;
    for (let k = cursor; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let k = s - 1; k >= cursor; k--) {
      const t = lines[k]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, end) });
    prevPath = path;
    cursor = end + 1;
  }
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const fp = splitFile(cur);
    const found = findTier(fp.lines, b.oldLines, tiersFor(strict), 0, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const nEntries: NEntry[] = b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const rep = buildReplacement(fp.lines, pos, b.oldLines, nEntries, found.tier);
    const out = [...fp.lines];
    out.splice(pos, b.oldLines.length, ...rep);
    tree.now.set(b.path, joinFile(out, fp.br, fp.finalBreak));
  });
}

// ---- Section 8: V4A patches ----

interface VBodyLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: VBodyLine[];
  fromAt: boolean;
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines?: string[];
  moveTo?: string | null;
  chunks?: VChunk[];
}

function isVSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
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
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isVSectionStart(lines[j]!)) {
        const l = lines[j]!;
        if (l.startsWith('+')) raw.push(l);
        else if (l === '') raw.push(l);
        else throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      sections.push({ kind: 'add', path, lines: raw.map((l) => (l === '' ? '' : l.slice(1))) });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      let j = i + 1;
      while (j < last && !isVSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      sections.push({ kind: 'delete', path });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let j = i + 1;
      while (j < last && !isVSectionStart(lines[j]!)) {
        const l = lines[j]!;
        if (j === i + 1 && l.startsWith('*** Move to: ')) {
          moveTo = l.slice(13).trim();
          j++;
          continue;
        }
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), eof: false, body: [], fromAt: true };
          chunks.push(cur);
          j++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          cur = null;
          j++;
          continue;
        }
        if (l.trim() === '' && cur === null) {
          if (chunks.length === 0) {
            cur = { anchor: null, eof: false, body: [], fromAt: false };
            chunks.push(cur);
            cur.body.push({ kind: 'ctx', text: '' });
          }
          j++;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, eof: false, body: [], fromAt: false };
              chunks.push(cur);
            } else throw new Exit2(`error: parse ${j + 1}`);
          }
          if (l === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (l.startsWith(' ')) cur.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) cur.body.push({ kind: 'del', text: l.slice(1) });
          else cur.body.push({ kind: 'add', text: l.slice(1) });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      // Blank lines at the end of the section are not part of it: strip trailing empty context lines
      // from the still-open last chunk; a body-started chunk emptied this way is no chunk at all.
      if (cur !== null && chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.body.length > 0 && lc.body[lc.body.length - 1]!.kind === 'ctx' && lc.body[lc.body.length - 1]!.text === '') lc.body.pop();
        if (lc.body.length === 0 && !lc.fromAt) chunks.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      sections.push({ kind: 'update', path, moveTo, chunks });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }

  return sections.map((s) => {
    if (s.kind === 'add') {
      const path = s.path;
      const fileLines = s.lines!;
      return (tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      };
    }
    if (s.kind === 'delete') {
      const path = s.path;
      return (tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      };
    }
    const path = s.path;
    const moveTo = s.moveTo ?? null;
    const chunks = s.chunks!;
    return (tree: Tree): [string, string] | void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const curText = tree.get(path);
      if (curText === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const fp = splitFile(curText);
      const lines = fp.lines;
      let cursor = 0;
      const tiers = tiersFor(strict);
      for (const ch of chunks) {
        if (ch.anchor !== null && ch.anchor !== '') {
          const at = findAnchor(lines, ch.anchor, tiers, cursor);
          if (at === null) throw new Fail('no-match', path);
          cursor = at + 1;
        }
        const o: string[] = [];
        const n: NEntry[] = [];
        for (const b of ch.body) {
          if (b.kind === 'ctx') {
            n.push({ text: b.text, ctx: true, oIdx: o.length });
            o.push(b.text);
          } else if (b.kind === 'del') {
            o.push(b.text);
          } else {
            n.push({ text: b.text, ctx: false, oIdx: -1 });
          }
        }
        if (o.length === 0) {
          const insertPos = ch.eof ? lines.length : cursor;
          const rep = buildReplacement(lines, insertPos, o, n, 0);
          lines.splice(insertPos, 0, ...rep);
          cursor = insertPos + rep.length;
        } else {
          const found = findTier(lines, o, tiers, cursor, ch.eof);
          if (found === null) throw new Fail('no-match', path);
          const pos = found.positions[0]!;
          const rep = buildReplacement(lines, pos, o, n, found.tier);
          lines.splice(pos, o.length, ...rep);
          cursor = pos + rep.length;
        }
      }
      const result = joinFile(lines, fp.br, fp.finalBreak);
      if (moveTo !== null) {
        tree.now.set(path, null);
        tree.now.set(moveTo, result);
        return [path, moveTo] as [string, string];
      }
      tree.now.set(path, result);
    };
  });
}

// ---- Section 9: JSON edits ----

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

// ---- Sections 1, 2, 10: invocation, output, order and atomicity ----

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const mv = edit(tree);
      if (mv !== undefined) moves.push(mv);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A successful move replaces its D and A lines with one R line, sorted by the new path; a move chain
  // (a -> b, then b -> c) counts as one move from its start to its end. Only when the old path existed
  // before the patch and does not after it, and the new path did not exist before it and does after it.
  const targets = new Set(moves.map((m) => m[1]));
  const next = new Map<string, string>(moves);
  const consumedOld = new Set<string>();
  const consumedNew = new Set<string>();
  interface Row {
    key: string;
    row: string;
  }
  const rows: Row[] = [];
  for (const [oldP, newP] of moves) {
    if (targets.has(oldP)) continue;
    let end = newP;
    const seen = new Set([oldP]);
    while (next.has(end) && !seen.has(end)) {
      seen.add(end);
      end = next.get(end)!;
    }
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(end) === null && tree.get(end) !== null) {
      consumedOld.add(oldP);
      consumedNew.add(end);
      rows.push({ key: end, row: `R ${oldP} -> ${end}` });
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (consumedOld.has(p) || consumedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, row: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.row);
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
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
