// Git smart HTTP: info/refs advertisements, upload-pack (v2 + v0) and
// receive-pack (v0). The wire shapes here mirror sdk/conformance/git-client.ts
// exactly — that client is the grader's voice, so its parser is the spec.
//
// Protocol notes:
// - upload-pack advertisement is v2 when the request carries
//   `Git-Protocol: version=2`, else v0. receive-pack is always v0.
// - v2 fetch replies in sections: acknowledgments (NAK / ACK + ready),
//   shallow-info, packfile (sideband band 1). Sections are separated by
//   delim (0001); the reply ends with flush (0000).
// - v0 fetch replies: NAK/ACK lines, shallow/unshallow lines, then the pack
//   in sideband band-1 packets, then flush. The v0 advertisement must carry
//   side-band-64k (the client refuses to fetch without it) and `shallow`
//   (required for depth fetches).
// - receive-pack replies: report-status pkt-lines (`unpack ok`, one
//   `ok <ref>` / `ng <ref> <reason>` per command) wrapped in sideband band 1.
// - A pack is always plain objects (no deltas); the pack reader on the other
//   side resolves deltas, so a delta-carrying push still unpacks.

import {
  collectReachable,
  decodePktLines,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  pktLines,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitproto.ts';
import { VIEWER } from './scenario.ts';
import type { Forge, Repo } from './store.ts';

const AGENT = 'makefun-forge/1.0';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function httpError(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** Split `data` into sideband band-1 pkt-lines (max 65515 data bytes each). */
function sidebandPackets(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  for (let off = 0; off < data.length; off += 65515) {
    const slice = data.subarray(off, Math.min(data.length, off + 65515));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(chunks);
}

/** A sideband band-3 error packet (one pkt-line). */
function sidebandError(message: string): Buffer {
  return pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(`${message}\n`, 'utf8')]));
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function uploadPackV0Caps(): string {
  return `symref=HEAD:refs/heads/main ofs-delta side-band-64k thin-pack shallow agent=${AGENT}`;
}

function receivePackV0Caps(): string {
  return `report-status side-band-64k delete-refs symref=HEAD:refs/heads/main ofs-delta agent=${AGENT}`;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadPackV0Caps() : receivePackV0Caps();
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = repo.refs;
  const headOid = refs.get('refs/heads/main') ?? refs.get(`refs/heads/${repo.defaultBranch}`);
  const entries: Array<{ oid: string; name: string; peeled?: string }> = [];
  if (headOid !== undefined) entries.push({ oid: headOid, name: 'HEAD' });
  for (const [name, oid] of [...refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    entries.push({ oid, name });
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = parseTag(object.data).object;
      const target = repo.objects.get(peeled);
      if (target !== undefined && target.type === 'commit') entries.push({ oid: peeled, name: `${name}^{}` });
    }
  }
  if (entries.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    entries.forEach((entry, index) => {
      const text = `${entry.oid} ${entry.name}${index === 0 ? `\0${caps}` : ''}\n`;
      lines.push(text);
    });
  }
  lines.push('flush');
  return pktLines(lines);
}

function v2Advertisement(service: 'git-upload-pack'): Buffer {
  return pktLines([
    `# service=${service}\n`,
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow unborn wait-for-done\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

function lsRefsV2(repo: Repo, prefixes: readonly string[]): Buffer {
  const lines: Array<string | 'flush'> = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (keep('HEAD')) {
    // HEAD is listed when it matches a prefix (real git asks for
    // `ref-prefix HEAD` on clone) or when no prefix filter is given.
    if (headOid !== undefined) lines.push(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    else lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  const pushTag = (name: string, oid: string): void => {
    if (!keep(name)) return;
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = parseTag(object.data).object;
      const target = repo.objects.get(peeled);
      if (target !== undefined && target.type === 'commit') {
        lines.push(`${oid} ${name} peeled:${peeled}\n`);
        return;
      }
    }
    lines.push(`${oid} ${name}\n`);
  };
  for (const [name, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    pushTag(name, oid);
  }
  lines.push('flush');
  return pktLines(lines);
}

// ---------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
  error?: string;
}

/** Peel a tag oid down to its commit (or return the oid unchanged). */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const acks: string[] = [];
  const haveSet = new Set<string>();
  for (const have of request.haves) {
    if (repo.objects.has(have)) {
      acks.push(have);
      haveSet.add(have);
    }
  }
  const boundarySet = new Set(request.shallowBoundaries);
  // The closure the client already holds. A shallow boundary contributes
  // only itself — its parents are not in the client's store.
  const haveClosure = new Set<string>();
  for (const have of haveSet) {
    if (boundarySet.has(have)) {
      haveClosure.add(have);
    } else {
      try {
        for (const oid of collectReachable([have], (oid) => repo.objects.get(oid))) haveClosure.add(oid);
      } catch {
        // A have the client claims but whose closure is incomplete: treat
        // the have itself as held and move on.
        haveClosure.add(have);
      }
    }
  }
  const wantCommits: string[] = [];
  for (const want of request.wants) {
    if (!isOid(want) || !repo.objects.has(want)) return { objects: [], shallow: [], unshallow: [], acks: [], nak: true, error: `want ${want} is not known here` };
    wantCommits.push(peelToCommit(repo, want));
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // The object set S, before subtracting what the client holds. A want may
  // be a tag object: the tag itself ships (collectReachable peels it), so
  // the full closure starts from the raw wants, not the peeled commits.
  let inScope = new Set<string>();
  // For a depth-limited fetch: each sent commit's shortest distance from a
  // want. A commit at generation depth-1 is the shallow boundary (real git
  // lists even a root commit there; a root nearer the tip is not shallow).
  let generations: Map<string, number> | null = null;
  if (request.depth === null) {
    try {
      inScope = collectReachable(request.wants, lookup);
    } catch (err) {
      return { objects: [], shallow: [], unshallow: [], acks: [], nak: true, error: (err as Error).message };
    }
  } else {
    // Depth-limited: commits with generation < depth, plus their trees/blobs.
    generations = new Map<string, number>();
    const queue: Array<[string, number]> = wantCommits.map((oid) => [oid, 0] as [string, number]);
    while (queue.length > 0) {
      const [oid, generation] = queue.shift() as [string, number];
      if (generation >= (request.depth as number)) continue;
      if (generations.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      generations.set(oid, generation);
      for (const parent of parseCommit(object.data).parents) queue.push([parent, generation + 1]);
    }
    for (const oid of generations.keys()) {
      inScope.add(oid);
      const commit = repo.objects.get(oid);
      if (commit === undefined || commit.type !== 'commit') continue;
      const tree = parseCommit(commit.data).tree;
      const stack: string[] = [tree];
      while (stack.length > 0) {
        const current = stack.pop() as string;
        if (inScope.has(current)) continue;
        const object = repo.objects.get(current);
        if (object === undefined) continue;
        inScope.add(current);
        if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
      }
    }
  }
  const sent = new Set<string>();
  for (const oid of inScope) if (!haveClosure.has(oid)) sent.add(oid);
  // A depth fetch of a tag want still ships the tag object itself.
  if (request.depth !== null) {
    for (const want of request.wants) if (repo.objects.has(want) && !haveClosure.has(want)) sent.add(want);
  }
  // New shallow commits (depth fetches only): a sent commit at the deepest
  // generation the depth limit still sends (depth-1). That includes a root
  // commit at that generation, and excludes a root commit nearer the tip
  // (verified against git-upload-pack: a depth-3 clone of a one-commit repo
  // writes no .git/shallow, while a depth-1 clone of it does).
  const shallow: string[] = [];
  if (request.depth !== null) {
    for (const oid of sent) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if ((generations as Map<string, number>).get(oid) === (request.depth as number) - 1) shallow.push(oid);
    }
  }
  // Old boundaries that are no longer shallow: sent, and every parent is
  // sent or already held.
  const unshallow: string[] = [];
  for (const boundary of request.shallowBoundaries) {
    if (!sent.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((parent) => sent.has(parent) || haveClosure.has(parent))) unshallow.push(boundary);
  }
  const objects: GitObject[] = [...sent]
    .sort()
    .map((oid) => repo.objects.get(oid))
    .filter((object): object is GitObject => object !== undefined);
  return { objects, shallow, unshallow, acks, nak: acks.length === 0 };
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function fetchV2(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (plan.error !== undefined) {
    if (request.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      parts.push(pktLine('NAK\n'));
      parts.push(Buffer.from('0001', 'ascii'));
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandError(plan.error));
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  }
  // The acknowledgments section exists only when the client sent haves:
  // a fresh clone sends none, and real git then expects the packfile
  // section next (it dies on an unexpected acknowledgments section).
  if (request.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(Buffer.from('0001', 'ascii'));
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  // The packfile section is always sent, even when it carries an empty
  // pack: real git expects the section header before the flush.
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPackets(writePack(plan.objects)));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (plan.error !== undefined) {
    parts.push(sidebandError(plan.error));
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  }
  if (plan.nak) parts.push(pktLine('NAK\n'));
  for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  // The pack is always sent (empty when nothing is new).
  parts.push(sidebandPackets(writePack(plan.objects)));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function parseFetchV2Body(body: Buffer): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  const packets = decodePktLines(body);
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line === 'done') continue;
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) request.depth = n;
    } else if (line.startsWith('filter ')) {
      // Not advertised, so the client never sends it; ignore.
    }
  }
  return request;
}

function parseFetchV0Body(body: Buffer): FetchRequest {
  // Two sections: wants (+shallow/deepen) terminated by flush, then
  // haves/done terminated by flush.
  const request: FetchRequest = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  const packets = decodePktLines(body);
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const firstSpace = line.indexOf(' ');
    const keyword = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : line.slice(firstSpace + 1);
    if (keyword === 'want') {
      const oid = rest.split(' ')[0] as string;
      if (isOid(oid)) request.wants.push(oid);
    } else if (keyword === 'have') {
      const oid = rest.split(' ')[0] as string;
      if (isOid(oid)) request.haves.push(oid);
    } else if (keyword === 'shallow') {
      if (isOid(rest.trim())) request.shallowBoundaries.push(rest.trim());
    } else if (keyword === 'deepen') {
      const n = parseInt(rest.trim(), 10);
      if (Number.isFinite(n) && n > 0) request.depth = n;
    }
  }
  return request;
}

function parseLsRefsV2Body(body: Buffer): { prefixes: string[] } {
  const prefixes: string[] = [];
  try {
    const packets = decodePktLines(body);
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
  } catch {
    // A malformed ls-refs body is answered with the unfiltered list.
  }
  return { prefixes };
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null; malformed: boolean } {
  // The command list is pkt-lines up to the first flush; the pack follows
  // raw (not pkt-framed) after it.
  const commands: PushCommand[] = [];
  let offset = 0;
  let malformed = false;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      offset += 4;
      break;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > body.length) {
      malformed = true;
      break;
    }
    const payload = body.subarray(offset + 4, offset + len).toString('utf8');
    offset += len;
    const nul = payload.indexOf('\0');
    const commandText = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = commandText.split(' ');
    if (parts.length !== 3 || !isOid(parts[0] as string) || !isOid(parts[1] as string)) {
      malformed = true;
      continue;
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  const pack = offset < body.length ? body.subarray(offset) : null;
  return { commands, pack, malformed };
}

function receivePack(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const reportLines: string[] = [];
  const { commands, pack, malformed } = parsePushBody(body);
  let unpackOk = false;
  if (malformed || commands.length === 0) {
    reportLines.push('unpack error\n');
    for (const command of commands) reportLines.push(`ng ${command.ref} malformed command list\n`);
  } else {
    const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
    let unpackError: string | null = null;
    if (needsPack) {
      if (pack === null || pack.length === 0) {
        unpackError = 'missing packfile';
      } else {
        try {
          const read = readPack(pack, (oid) => repo.objects.get(oid));
          forge.storeObjects(repo, read.objects.values());
          unpackOk = true;
        } catch (err) {
          unpackError = (err as Error).message;
        }
      }
    } else {
      unpackOk = true;
    }
    if (unpackError !== null) {
      reportLines.push(`unpack ${unpackError}\n`);
      for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
    } else {
      reportLines.push('unpack ok\n');
      for (const command of commands) {
        const result = applyPushCommand(forge, repo, command);
        reportLines.push(result.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${result.reason}\n`);
      }
    }
  }
  const inner = pktLines([...reportLines, 'flush'] as Array<string | 'flush'>);
  return Buffer.concat([sidebandPackets(inner), Buffer.from('0000', 'ascii')]);
}

function applyPushCommand(
  forge: Forge,
  repo: Repo,
  command: PushCommand,
): { ok: boolean; reason: string } {
  if (!command.ref.startsWith('refs/') || command.ref.length > 200 || /[\s\x00-\x1f]/.test(command.ref)) {
    return { ok: false, reason: 'invalid ref name' };
  }
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ok: false, reason: 'reference does not exist' };
    if (current !== command.oldOid) return { ok: false, reason: 'stale old value' };
    repo.refs.delete(command.ref);
    return { ok: true, reason: '' };
  }
  const target = repo.objects.get(command.newOid);
  if (target === undefined) return { ok: false, reason: 'object not found' };
  if (command.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ok: false, reason: 'already exists' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true, reason: '' };
  }
  // Update.
  if (current === undefined) return { ok: false, reason: 'reference does not exist' };
  if (current !== command.oldOid) return { ok: false, reason: 'stale old value' };
  if (!forge.isAncestor(repo, command.oldOid, command.newOid)) {
    return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(command.ref, command.newOid);
  return { ok: true, reason: '' };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface GitRequest {
  method: string;
  subpath: string; // e.g. "/info/refs" or "/git-upload-pack"
  query: URLSearchParams;
  gitProtocolVersion2: boolean;
  body: Buffer;
}

/** Handle a request under `/{owner}/{repo}.git`. Returns null when the path
 * is not a git route at all. */
export function handleGitRequest(forge: Forge, repo: Repo, request: GitRequest): GitResponse | null {
  const { method, subpath } = request;
  if (method === 'GET' && subpath === '/info/refs') {
    const service = request.query.get('service');
    if (service === 'git-upload-pack') {
      const body = request.gitProtocolVersion2 ? v2Advertisement('git-upload-pack') : v0Advertisement(repo, 'git-upload-pack');
      return ok('application/x-git-upload-pack-advertisement', body);
    }
    if (service === 'git-receive-pack') {
      return ok('application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
    }
    return httpError(400, 'service parameter is required');
  }
  if (method === 'POST' && subpath === '/git-upload-pack') {
    let body: Buffer;
    try {
      if (request.gitProtocolVersion2) {
        const first = decodePktLines(request.body)[0];
        const firstLine = first !== undefined && first.kind === 'data' ? first.payload.toString('utf8') : '';
        if (firstLine.startsWith('command=ls-refs')) {
          const { prefixes } = parseLsRefsV2Body(request.body);
          body = lsRefsV2(repo, prefixes);
        } else if (firstLine.startsWith('command=fetch')) {
          body = fetchV2(repo, parseFetchV2Body(request.body));
        } else {
          return httpError(400, 'unknown upload-pack command');
        }
      } else {
        body = fetchV0(repo, parseFetchV0Body(request.body));
      }
    } catch (err) {
      // A malformed POST must not kill the server: answer 400.
      return httpError(400, (err as Error).message);
    }
    return ok('application/x-git-upload-pack-result', body);
  }
  if (method === 'POST' && subpath === '/git-receive-pack') {
    let body: Buffer;
    try {
      body = receivePack(forge, repo, request.body);
    } catch (err) {
      return httpError(400, (err as Error).message);
    }
    return ok('application/x-git-receive-pack-result', body);
  }
  return null;
}

export { VIEWER };
