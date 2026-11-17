// Git object model + pkt-line + packfile primitives. Node stdlib only
// (node:crypto, node:zlib). Plain objects in packs (no deltas on write);
// pack reading resolves OFS_DELTA and REF_DELTA too, so a delta-carrying
// pack from any client still unpacks.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

/** One pkt-line: 4 hex length digits + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.allocUnsafe(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

export function pktLines(parts: readonly (string | Buffer | 'flush' | 'delim' | 'end')[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (part === 'flush') chunks.push(PKT_FLUSH);
    else if (part === 'delim') chunks.push(PKT_DELIM);
    else if (part === 'end') chunks.push(PKT_END);
    else chunks.push(pktLine(part));
  }
  return Buffer.concat(chunks);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'end';
export interface Pkt {
  kind: PktKind;
  payload: Buffer; // empty for flush/delim/end
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed line. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pkt-line truncated');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (head === '0001') { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (head === '0002') { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------

function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset] as number;
    offset += 1;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  declaredCount: number;
}

/** Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA. Verifies the
 * SHA-1 of every object against its id. `resolveBase` supplies objects the
 * client already holds (thin packs). */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Trailer check.
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== expected) throw new Error('pack trailer checksum mismatch');

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  const end = pack.length - 20;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const { size, next, first } = readVarintSize(pack, offset);
    const typeCode = (first >> 4) & 0x07;
    offset = next;
    let object: GitObject;
    if (typeCode === 6) {
      // OFS_DELTA
      const { baseOffset, next: afterBase } = readOfsDeltaBase(pack, offset);
      offset = afterBase;
      const { data, next: afterData } = inflateAt(pack, offset);
      offset = afterData;
      const base = byOffset.get(entryOffset - baseOffset);
      if (base === undefined) throw new Error('ofs-delta base not in this pack');
      const resolved = applyDelta(base.data, data);
      object = { type: base.type, data: resolved };
      deltaCount += 1;
    } else if (typeCode === 7) {
      // REF_DELTA
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data, next: afterData } = inflateAt(pack, offset);
      offset = afterData;
      const base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} is unknown`);
      const resolved = applyDelta(base.data, data);
      object = { type: base.type, data: resolved };
      deltaCount += 1;
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, next: afterData } = inflateAt(pack, offset);
      offset = afterData;
      if (data.length !== size) throw new Error(`object size mismatch: header ${size}, inflated ${data.length}`);
      object = { type, data };
    }
    const oid = hashObject(object.type, object.data);
    objects.set(oid, object);
    byOffset.set(entryOffset, object);
  }
  if (offset !== end) throw new Error('pack has trailing bytes before the trailer');
  return { objects, deltaCount, declaredCount: count };
}

// ---------------------------------------------------------------------------
// object parsing
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) throw new Error('bad tree entry');
    const mode = data.subarray(off, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('bad tree entry');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    // Git sorts by name, with directories compared as if named "name/".
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const message = headerEnd >= 0 ? text.slice(headerEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: { tree: string; parents: readonly string[]; author: string; committer: string; message: string }): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  lines.push('');
  lines.push(fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const message = headerEnd >= 0 ? text.slice(headerEnd + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** All objects reachable from `tips` (commits + their trees/blobs, tags
 * peeled), following parents. Throws when an object is missing. */
export function collectReachable(
  tips: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** The tree object id at `path` inside `treeOid` (or null when absent). */
export function treeLookup(
  lookup: (oid: string) => GitObject | undefined,
  treeOid: string,
  path: string,
): { oid: string; type: ObjectType } | null {
  const segments = path.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) {
      const target = lookup(entry.oid);
      if (target === undefined) return null;
      return { oid: entry.oid, type: target.type };
    }
    current = entry.oid;
  }
  return null;
}

/** All (path -> blob oid) pairs under a tree, recursively. */
export function flattenTree(
  lookup: (oid: string) => GitObject | undefined,
  treeOid: string,
  prefix = '',
): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, base: string): void => {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry.oid);
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build the tree for a full file map (path -> blob oid), storing each
 * intermediate tree through `store` (which returns its oid). */
export function buildTreeFromFilesWithStore(
  files: Map<string, string>,
  store: (type: ObjectType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of [...node.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      entries.push({ mode: '100644', name, oid });
    }
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    return store('tree', buildTree(entries));
  };
  return build(root);
}
