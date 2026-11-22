// mend: one patch tool for every AI edit format.
//
// mend applies an edit written by an AI model to a tree of text files. The
// patch may be a unified diff, a set of SEARCH/REPLACE blocks, a V4A patch
// or a list of JSON edit objects; the format is detected unless --format
// names one. Every edit in the patch is applied to an in-memory copy of the
// tree and the tree is written only when no edit failed, so a patch changes
// every file it touches or none of them. Lines an edit looks for are matched
// at the first of three tiers that finds them: exact, then ignoring trailing
// blanks, then ignoring leading blanks as well (and re-indenting the new
// lines to the file's own indentation).
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
// When MAKEFUN_ENV_URL is set this file hands over to runner.ts, which runs
// the CLI once per check of a trial; that hand-over is at the bottom.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 failure: the single line to print, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: a code (no-match, ambiguous, ...) and the path it concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, and no
 *  empty piece after a final \n. Patch line numbers count these from 1. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path: not empty, not absolute, no backslash, and no segment that
 *  is empty, "." or "..". */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function needSafe(p: string): void {
  if (!isSafePath(p)) throw new Fail('unsafe', p);
}

// ---------------------------------------------------------------------------
// The tree: original bytes are read from disk once; edits record the new
// bytes (or null for a deletion) in `now`. Nothing reaches the disk until
// every edit has succeeded.
// ---------------------------------------------------------------------------

class Tree {
  private readonly before = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, as [oldPath, newPath] pairs, in patch order. */
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.before.has(p)) {
      let value: string | null = null;
      try {
        if (statSync(p).isFile()) value = readFileSync(p, 'utf8');
      } catch {
        value = null;
      }
      this.before.set(p, value);
    }
    return this.before.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Files as lines. A file's break is CRLF when its first line feed follows a
// carriage return, LF otherwise. Its lines are the text split at that break;
// a trailing break does not make a last empty line.
// ---------------------------------------------------------------------------

interface FileLines {
  lines: string[];
  br: string;
  endsWithBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const firstNl = text.indexOf('\n');
  const br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(br);
  const parts = text.split(br);
  if (endsWithBreak) parts.pop();
  return { lines: parts, br, endsWithBreak };
}

function joinFile(lines: string[], br: string, endsWithBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (endsWithBreak ? br : '');
}

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC section 5).
// ---------------------------------------------------------------------------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineMatchesAt(fileLine: string, want: string, tier: number): boolean {
  if (tier === 0) return fileLine === want;
  if (tier === 1) return stripTrail(fileLine) === stripTrail(want);
  return stripBoth(fileLine) === stripBoth(want);
}

function blockMatchesAt(lines: string[], pos: number, old: string[], tier: number): boolean {
  for (let k = 0; k < old.length; k += 1) {
    if (!lineMatchesAt(lines[pos + k]!, old[k]!, tier)) return false;
  }
  return true;
}

interface TierHit {
  tier: number;
  positions: number[];
}

/** The first tier (0 only when strict) at which `old` occurs in `lines` at
 *  or after `from`, optionally only where the occurrence ends at the last
 *  line; null when no tier finds it. */
function findTier(lines: string[], old: string[], strict: boolean, from = 0, mustEndAtLast = false): TierHit | null {
  const lastTier = strict ? 0 : 2;
  for (let tier = 0; tier <= lastTier; tier += 1) {
    const positions: number[] = [];
    for (let i = from; i + old.length <= lines.length; i += 1) {
      if (mustEndAtLast && i + old.length !== lines.length) continue;
      if (blockMatchesAt(lines, i, old, tier)) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first tier at which a single line equal to `want` occurs at or after
 *  `from` (used for V4A anchors); returns its index or -1. */
function findAnchor(lines: string[], want: string, strict: boolean, from: number): number {
  const lastTier = strict ? 0 : 2;
  for (let tier = 0; tier <= lastTier; tier += 1) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineMatchesAt(lines[i]!, want, tier)) return i;
    }
  }
  return -1;
}

/** One line of a replacement: either a context line (ctx >= 0 indexes into
 *  the matched old lines, and the file's own line is written) or a new line. */
interface NewLine {
  text: string;
  ctx: number;
}

/** Build the lines that replace the matched ones. Context lines come from
 *  the file itself; at tier 2 every other new line is re-indented: a line
 *  starting with the old block's first-line prefix P gets the file's own
 *  first-line prefix F in its place. */
function buildReplacement(matched: string[], old: string[], fresh: NewLine[], tier: number): string[] {
  const out: string[] = [];
  const fileLead = matched.length > 0 ? leadWs(matched[0]!) : '';
  const patchLead = old.length > 0 ? leadWs(old[0]!) : '';
  for (const item of fresh) {
    if (item.ctx >= 0) {
      out.push(matched[item.ctx]!);
      continue;
    }
    let text = item.text;
    if (tier === 2 && text.trim() !== '' && text.startsWith(patchLead)) {
      text = fileLead + text.slice(patchLead.length);
    }
    out.push(text);
  }
  return out;
}

/** Split a patch body (context/old/new entries) into the old lines and the
 *  replacement lines. Entry kinds are ' ' context, '-' old, '+' new. */
function bodyToOldNew(body: Array<{ kind: string; text: string }>): { old: string[]; fresh: NewLine[] } {
  const old: string[] = [];
  const fresh: NewLine[] = [];
  for (const entry of body) {
    if (entry.kind === ' ') {
      old.push(entry.text);
      fresh.push({ text: entry.text, ctx: old.length - 1 });
    } else if (entry.kind === '-') {
      old.push(entry.text);
    } else if (entry.kind === '+') {
      fresh.push({ text: entry.text, ctx: -1 });
    }
  }
  return { old, fresh };
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4): the first rule that holds wins.
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const firstIdx = lines.findIndex((l) => !isBlank(l));
  if (firstIdx < 0) return null;
  if (lines[firstIdx]!.trim() === '*** Begin Patch') return 'v4a';
  const firstChar = lines[firstIdx]!.trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  const hasDiff = lines.some(
    (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
  );
  if (hasDiff) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9). The patch is one JSON array of edit objects
// or JSON Lines with one object a line. Any object that is not a valid edit
// is a parse fault at the line the format's rules name.
// ---------------------------------------------------------------------------

function jsonEdit(value: unknown): Edit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const path = obj.path;
  if (typeof path !== 'string') return null;

  const readExisting = (tree: Tree): string => {
    needSafe(path);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    return text;
  };

  if (obj.command === 'create' && typeof obj.file_text === 'string') {
    const text = obj.file_text;
    return (tree) => {
      needSafe(path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, text);
    };
  }

  if (
    obj.command === 'str_replace' &&
    typeof obj.old_str === 'string' &&
    obj.old_str !== '' &&
    (obj.new_str === undefined || typeof obj.new_str === 'string')
  ) {
    const oldStr = obj.old_str;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const nlAt = before.indexOf('\n');
      const crlf = nlAt > 0 && before[nlAt - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const text = toLf(before);
      const needle = toLf(oldStr);
      let count = 0;
      for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', path);
      if (count > 1) throw new Fail('ambiguous', path);
      const at = text.indexOf(needle);
      const replaced = text.slice(0, at) + toLf(newStr) + text.slice(at + needle.length);
      tree.now.set(path, crlf ? replaced.split('\n').join('\r\n') : replaced);
    };
  }

  if (
    obj.command === 'insert' &&
    typeof obj.insert_line === 'number' &&
    Number.isInteger(obj.insert_line) &&
    typeof obj.new_str === 'string'
  ) {
    const lineNo = obj.insert_line;
    const added = patchLines(obj.new_str);
    return (tree) => {
      const before = readExisting(tree);
      const file = splitFile(before);
      if (lineNo < 0 || lineNo > file.lines.length) throw new Fail('no-match', path);
      const lines = [...file.lines];
      lines.splice(lineNo, 0, ...added);
      tree.now.set(path, joinFile(lines, file.br, file.endsWithBreak));
    };
  }

  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const firstIdx = lines.findIndex((l) => !isBlank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[firstIdx]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${firstIdx + 1}`);
    }
    if (!Array.isArray(parsed)) throw new Exit2(`error: parse ${firstIdx + 1}`);
    for (const item of parsed) {
      const edit = jsonEdit(item);
      if (edit === null) throw new Exit2(`error: parse ${firstIdx + 1}`);
      edits.push(edit);
    }
    return edits;
  }
  lines.forEach((line, idx) => {
    if (isBlank(line)) return;
    let edit: Edit | null = null;
    try {
      edit = jsonEdit(JSON.parse(line));
    } catch {
      edit = null;
    }
    if (edit === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(edit);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6). A section starts at a `diff --git` line or
// at a `--- `/`+++ ` pair; it is one edit. Its hunks apply in order, each to
// the result of the ones before it, choosing the occurrence nearest to the
// position the (often wrong) header numbers suggest.
// ---------------------------------------------------------------------------

interface BodyEntry {
  kind: string; // ' ', '-', '+' or '\\'
  text: string;
  rawEmpty: boolean; // the patch line itself was empty (a bare context line)
}

interface Hunk {
  a: number; // the A of @@ -A[,B] +C[,D] @@
  body: BodyEntry[];
}

interface Section {
  diffOld: string | undefined;
  diffNew: string | undefined;
  headOld: string | null | undefined; // null means /dev/null
  headNew: string | null | undefined;
  hasPair: boolean;
  renameOld: string | undefined;
  renameNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    diffOld: undefined,
    diffNew: undefined,
    headOld: undefined,
    headNew: undefined,
    hasPair: false,
    renameOld: undefined,
    renameNew: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

/** The path a --- or +++ line names: text after the four characters, up to
 *  the first tab, surrounding spaces removed; /dev/null becomes null and a
 *  leading a/ or b/ is removed. */
function headerPath(line: string): string | null {
  let raw = line.slice(4);
  const tabAt = raw.indexOf('\t');
  if (tabAt >= 0) raw = raw.slice(0, tabAt);
  raw = raw.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) raw = raw.slice(2);
  return raw;
}

/** True when the hunk's last context or + line is followed by a \ line. */
function slashAfterLastNew(body: BodyEntry[]): boolean {
  let last = -1;
  body.forEach((entry, idx) => {
    if (entry.kind === ' ' || entry.kind === '+') last = idx;
  });
  return last >= 0 && body[last + 1]?.kind === '\\';
}

/** Apply one section's hunks to a file's text; throws Fail on no-match. */
function applyHunks(content: string, hunks: Hunk[], path: string, strict: boolean): string {
  const file = splitFile(content);
  const lines = [...file.lines];
  let endsWithBreak = file.endsWithBreak;
  let drift = 0; // sum over hunks applied so far of (new length - old length)
  for (const hunk of hunks) {
    const { old, fresh } = bodyToOldNew(hunk.body);
    const noEol = slashAfterLastNew(hunk.body);
    if (old.length === 0) {
      const pos = Math.min(hunk.a + drift, lines.length);
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...fresh.map((f) => f.text));
      if (atEnd && fresh.length > 0) endsWithBreak = !noEol;
    } else {
      const hit = findTier(lines, old, strict);
      if (hit === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + drift;
      let pos = hit.positions[0]!;
      for (const cand of hit.positions) {
        if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      }
      const matched = lines.slice(pos, pos + old.length);
      const replacement = buildReplacement(matched, old, fresh, hit.tier);
      const atEnd = pos + old.length === lines.length;
      lines.splice(pos, old.length, ...replacement);
      if (atEnd) endsWithBreak = !noEol;
    }
    drift += fresh.length - old.length;
  }
  return joinFile(lines, file.br, endsWithBreak);
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const flush = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const sep = rest.startsWith('a/') ? rest.indexOf(' b/') : -1;
      if (sep < 0 || rest.slice(2, sep) === '' || rest.slice(sep + 3) === '') {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush();
      cur = newSection();
      cur.diffOld = rest.slice(2, sep);
      cur.diffNew = rest.slice(sep + 3);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.hasPair) {
        flush();
        cur = newSection();
      }
      cur.headOld = headerPath(line);
      cur.headNew = headerPath(lines[i + 1]!);
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:\s.*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyEntry[] = [];
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: ' ', text: '', rawEmpty: true });
          i += 1;
          continue;
        }
        const kind = bl[0]!;
        if (kind === ' ' || kind === '-' || kind === '+' || kind === '\\') {
          body.push({ kind, text: bl.slice(1), rawEmpty: false });
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Still in the section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      // index, mode, similarity and every other header line are ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not a section header are ignored.
    i += 1;
  }
  flush();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function unifiedEdit(section: Section, strict: boolean): Edit {
  const oldPath = section.hasPair ? section.headOld : section.renameOld ?? section.diffOld;
  const newPath = section.hasPair ? section.headNew : section.renameNew ?? section.diffNew;
  const isCreate = oldPath === null || section.newFile;
  const isDelete = newPath === null || section.deletedFile;
  return (tree) => {
    if (isCreate) {
      const p = newPath as string;
      needSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noEol = false;
      for (const hunk of section.hunks) {
        hunk.body.forEach((entry, idx) => {
          if (entry.kind === '+') {
            plus.push(entry.text);
            noEol = hunk.body[idx + 1]?.kind === '\\';
          }
        });
      }
      tree.now.set(p, joinFile(plus, '\n', !noEol));
      return;
    }
    if (isDelete) {
      const p = oldPath as string;
      needSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = oldPath as string;
    const to = newPath as string;
    if (from !== to) {
      needSafe(from);
      needSafe(to);
      const content = tree.get(from);
      if (content === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const result = applyHunks(content, section.hunks, from, strict);
      tree.now.set(from, null);
      tree.now.set(to, result);
      tree.moves.push([from, to]);
      return;
    }
    needSafe(from);
    const content = tree.get(from);
    if (content === null) throw new Fail('missing', from);
    tree.now.set(from, applyHunks(content, section.hunks, from, strict));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7). Each block names its file on the
// nearest usable line before its SEARCH marker, or reuses the previous
// block's path. The old lines must occur exactly once at their tier.
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  old: string[];
  fresh: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1; // index of the previous block's REPLACE line
  let prevPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // The path: nearest line before SEARCH, after the previous block, that
    // is not blank and does not (trimmed) start with three backticks.
    let path: string | undefined;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new Exit2(`error: parse ${searchIdx + 1}`);
    // Find ======= and then >>>>>>> REPLACE after the SEARCH line.
    let eqIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
    }
    let repIdx = -1;
    if (eqIdx >= 0) {
      for (let j = eqIdx + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          repIdx = j;
          break;
        }
      }
    }
    if (eqIdx < 0 || repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({
      path,
      old: lines.slice(searchIdx + 1, eqIdx),
      fresh: lines.slice(eqIdx + 1, repIdx),
    });
    prevPath = path;
    prevEnd = repIdx;
    i = repIdx + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((block) => {
    const p = block.path;
    return (tree: Tree): void => {
      needSafe(p);
      if (block.old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile(block.fresh, '\n', true));
        return;
      }
      const content = tree.get(p);
      if (content === null) throw new Fail('missing', p);
      const file = splitFile(content);
      const hit = findTier(file.lines, block.old, strict);
      if (hit === null) throw new Fail('no-match', p);
      if (hit.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = hit.positions[0]!;
      const matched = file.lines.slice(pos, pos + block.old.length);
      const freshLines: NewLine[] = block.fresh.map((text) => ({ text, ctx: -1 }));
      const replacement = buildReplacement(matched, block.old, freshLines, hit.tier);
      const out = [...file.lines];
      out.splice(pos, block.old.length, ...replacement);
      tree.now.set(p, joinFile(out, file.br, file.endsWithBreak));
    };
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8). Sections add, delete or update one file;
// an update is a sequence of chunks applied with a cursor that only moves
// forward, optionally anchored, optionally pinned to the end of the file.
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyEntry[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerIdx: number; // 0-based patch line of the section header
  addLines: string[];
  moveTo: string | undefined;
  chunks: V4aChunk[];
}

function parseV4a(lines: string[]): V4aSection[] {
  const firstIdx = lines.findIndex((l) => !isBlank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  lines.forEach((l, idx) => {
    if (!isBlank(l)) lastIdx = idx;
  });
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    let kind: V4aSection['kind'] | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    }
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const section: V4aSection = { kind, path, headerIdx: i, addLines: [], moveTo: undefined, chunks: [] };
    i += 1;
    // Collect this section's raw lines, up to the next section or End Patch.
    const raw: Array<{ idx: number; text: string }> = [];
    while (i < lastIdx) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ idx: i, text: l });
      i += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'add') {
      for (const entry of raw) {
        if (entry.text.startsWith('+')) section.addLines.push(entry.text.slice(1));
        else if (entry.text === '') section.addLines.push('');
        else throw new Exit2(`error: parse ${entry.idx + 1}`);
      }
    } else if (kind === 'delete') {
      const stray = raw.find((entry) => !isBlank(entry.text));
      if (stray !== undefined) throw new Exit2(`error: parse ${stray.idx + 1}`);
    } else {
      let start = 0;
      while (start < raw.length && isBlank(raw[start]!.text)) start += 1;
      if (start < raw.length && raw[start]!.text.startsWith('*** Move to: ')) {
        section.moveTo = raw[start]!.text.slice('*** Move to: '.length).trim();
        start += 1;
      } else {
        start = 0;
      }
      let chunk: V4aChunk | null = null;
      let closed = false; // a chunk ended by *** End of File
      for (let k = start; k < raw.length; k += 1) {
        const entry = raw[k]!;
        const l = entry.text;
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          chunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          section.chunks.push(chunk);
          closed = false;
        } else if (l === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: true, body: [] };
            section.chunks.push(chunk);
          } else {
            chunk.eof = true;
          }
          closed = true;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (chunk === null || closed) {
            chunk = { anchor: null, eof: false, body: [] };
            section.chunks.push(chunk);
            closed = false;
          }
          chunk.body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1), rawEmpty: l === '' });
        } else {
          throw new Exit2(`error: parse ${entry.idx + 1}`);
        }
      }
      if (section.chunks.length === 0 && section.moveTo === undefined) {
        throw new Exit2(`error: parse ${section.headerIdx + 1}`);
      }
    }
    sections.push(section);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((section) => {
    const p = section.path;
    return (tree: Tree): void => {
      needSafe(p);
      if (section.kind === 'add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile(section.addLines, '\n', true));
        return;
      }
      if (section.kind === 'delete') {
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      // update, with an optional move
      const target = section.moveTo;
      if (target !== undefined) needSafe(target);
      const content = tree.get(p);
      if (content === null) throw new Fail('missing', p);
      if (target !== undefined && tree.get(target) !== null) throw new Fail('exists', target);
      const file = splitFile(content);
      const out = [...file.lines];
      let cursor = 0;
      for (const chunk of section.chunks) {
        if (chunk.anchor !== null) {
          const at = findAnchor(out, chunk.anchor, strict, cursor);
          if (at < 0) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        const { old, fresh } = bodyToOldNew(chunk.body);
        if (old.length === 0) {
          const pos = chunk.eof ? out.length : cursor;
          out.splice(pos, 0, ...fresh.map((f) => f.text));
          cursor = pos + fresh.length;
          continue;
        }
        const hit = findTier(out, old, strict, cursor, chunk.eof);
        if (hit === null) throw new Fail('no-match', p);
        const pos = hit.positions[0]!;
        const matched = out.slice(pos, pos + old.length);
        const replacement = buildReplacement(matched, old, fresh, hit.tier);
        out.splice(pos, old.length, ...replacement);
        cursor = pos + replacement.length;
      }
      const result = joinFile(out, file.br, file.endsWithBreak);
      if (target !== undefined) {
        tree.now.set(p, null);
        tree.now.set(target, result);
        tree.moves.push([p, target]);
      } else {
        tree.now.set(p, result);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// The command line (SPEC sections 1, 2 and 10). Edits run in patch order
// against the tree as earlier edits left it; a failed edit changes nothing
// and the edits after it still run. When any edit failed nothing is written;
// when none did, every change is written (or, with --check, none is).
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=') && format === null && FORMAT_NAMES.includes(arg.slice('--format='.length))) {
        format = arg.slice('--format='.length);
      } else if (arg === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (arg === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchFile = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let patchText = '';
  try {
    patchText = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(patchText);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(patchText, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (err) {
    if (err instanceof Exit2) return { code: 2, out: [err.line] };
    throw err;
  }

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const savedNow = new Map(tree.now);
    const savedMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (err) {
      if (!(err instanceof Fail)) throw err;
      tree.now.clear();
      for (const [k, v] of savedNow) tree.now.set(k, v);
      tree.moves.length = savedMoves;
      fails.push(err);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // Work out the report lines. A successful move whose old path existed
  // before the patch and is gone now, and whose new path did not exist
  // before and exists now, is reported as one R line (sorted by the new
  // path) instead of a D and an A line.
  interface Row {
    sortKey: string;
    line: string;
    paths: string[];
  }
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const consumed = new Set<string>();
  const rows: Row[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    if (!changed.includes(oldP) || !changed.includes(newP)) continue;
    if (tree.original(oldP) === null || tree.now.get(oldP) !== null) continue;
    if (tree.original(newP) !== null || tree.now.get(newP) === null) continue;
    rows.push({ sortKey: newP, line: `R ${oldP} -> ${newP}`, paths: [oldP, newP] });
    consumed.add(oldP);
    consumed.add(newP);
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const nowValue = tree.now.get(p)!;
    rows.push({ sortKey: p, line: `${was === null ? 'A' : nowValue === null ? 'D' : 'M'} ${p}`, paths: [p] });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.sortKey), Buffer.from(y.sortKey)));

  if (!checkOnly) {
    for (const p of changed) {
      const nowValue = tree.now.get(p)!;
      if (nowValue === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, nowValue);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const result = run(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
