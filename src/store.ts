// The forge's in-memory store: repositories, git objects, refs, issues,
// pull requests, labels and comments. Every surface (REST, GraphQL, MCP,
// git smart HTTP) reads and writes this one store, so a change on one
// surface is visible on the others immediately.
//
// Determinism: nothing here reads a clock or Math.random. Generated commit
// timestamps come from scenario.trialNowSec(); ids are sequential counters.

import {
  buildCommit,
  buildTreeFromFilesWithStore,
  collectReachable,
  flattenTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type ObjectType,
} from './gitproto.ts';
import { VIEWER, trialNowIso, trialNowSec } from './scenario.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
}

export interface Pull {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export type Numbered = Issue | Pull;

export interface Repo {
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  databaseId: number;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  numbered: Numbered[];
  nextNumber: number;
  nextCommentId: number;
}

export interface ContentFile {
  type: 'file';
  encoding: 'base64';
  content: string;
  sha: string;
  size: number;
  path: string;
  name: string;
}

export interface ContentDirEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  sha: string;
}

const COMMIT_AUTHOR = `${VIEWER.name} <${VIEWER.email}>`;

function gitTimestamp(): string {
  return `${trialNowSec()} +0000`;
}

/** Count lines the way a diff does (a trailing newline does not add one). */
function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** Multiset line difference: [added, deleted] line counts. */
function lineDiff(oldText: string, newText: string): [number, number] {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of newLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added += 1;
  }
  let deleted = 0;
  for (const left of counts.values()) deleted += left;
  return [added, deleted];
}

export class Forge {
  readonly viewerLogin = VIEWER.login;
  private repos = new Map<string, Repo>();
  private repoOrder: Repo[] = [];
  private nextDbId = 1;
  private nextGlobalId = 1;
  private seq = 0;

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  // ---------------------------------------------------------------- repos

  createRepo(name: string, opts: { private?: boolean; description?: string } = {}): Repo | null {
    const key = this.key(VIEWER.login, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      name,
      owner: VIEWER.login,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      databaseId: this.nextDbId,
      createdSeq: this.seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      numbered: [],
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextDbId += 1;
    this.seq += 1;
    this.repos.set(key, repo);
    this.repoOrder.push(repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    // A repository belongs to the login the token names; any other owner is
    // a 404, never a 403.
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    const key = this.key(owner, name);
    const repo = this.repos.get(key);
    if (repo === undefined) return false;
    this.repos.delete(key);
    const index = this.repoOrder.indexOf(repo);
    if (index >= 0) this.repoOrder.splice(index, 1);
    return true;
  }

  listRepos(): Repo[] {
    return this.repoOrder;
  }

  // ---------------------------------------------------------------- objects

  storeObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Store many objects at once (a received pack). Returns the oids. */
  storeObjects(repo: Repo, objects: Iterable<GitObject>): string[] {
    const out: string[] = [];
    for (const object of objects) out.push(this.storeObject(repo, object.type, object.data));
    return out;
  }

  // ---------------------------------------------------------------- refs

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Resolve a branch name, full ref, or commit oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
    return undefined;
  }

  /** The default branch's tip, or undefined when the repo has no commits. */
  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** Commits reachable from `tip`, newest first (pre-order DFS). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const commit = parseCommit(object.data);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
    }
    return out;
  }

  /** Is `ancestor` reachable from `tip`? */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /** The merge-base of two commits (nearest common ancestor, BFS order). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Map<string, number>();
    const queueA: Array<[string, number]> = [[a, 0]];
    while (queueA.length > 0) {
      const [oid, dist] = queueA.shift() as [string, number];
      if (ancestorsA.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      ancestorsA.set(oid, dist);
      for (const parent of parseCommit(object.data).parents) queueA.push([parent, dist + 1]);
    }
    const queueB: Array<[string, number]> = [[b, 0]];
    const seenB = new Set<string>();
    let best: string | null = null;
    let bestScore = Infinity;
    while (queueB.length > 0) {
      const [oid, dist] = queueB.shift() as [string, number];
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const da = ancestorsA.get(oid);
      if (da !== undefined) {
        const score = Math.max(da, dist);
        if (score < bestScore) {
          bestScore = score;
          best = oid;
        }
      }
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push([parent, dist + 1]);
    }
    return best;
  }

  // ---------------------------------------------------------------- commits

  /** Create a commit object on `repo` and store it. */
  makeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const stamp = gitTimestamp();
    const data = buildCommit({
      tree,
      parents,
      author: `${COMMIT_AUTHOR} ${stamp}`,
      committer: `${COMMIT_AUTHOR} ${stamp}`,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    return this.storeObject(repo, 'commit', data);
  }

  // ---------------------------------------------------------------- contents

  /** The file map of a commit's tree (path -> blob oid). */
  fileMap(repo: Repo, commitOid: string): Map<string, string> {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return new Map();
    return flattenTree((oid) => repo.objects.get(oid), parseCommit(commit.data).tree);
  }

  putContent(
    repo: Repo,
    opts: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
  ): { status: 200 | 201; commitSha: string; contentSha: string } | { status: 404; message: string } | { status: 409; message: string } {
    const branch = opts.branch ?? repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${branch}`);
    const isNewBranch = tip === undefined;
    if (isNewBranch) {
      // A write to a branch that does not exist creates it from the default
      // branch's tip (or as the root commit when the repo is empty).
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    const files = tip !== undefined ? this.fileMap(repo, tip) : new Map<string, string>();
    const existing = files.get(opts.path);
    if (opts.sha !== undefined && existing !== undefined && opts.sha.toLowerCase() !== existing.toLowerCase()) {
      return { status: 409, message: 'sha does not match the current blob' };
    }
    const isCreate = existing === undefined;
    const contentSha = this.storeObject(repo, 'blob', opts.content);
    files.set(opts.path, contentSha);
    const tree = buildTreeFromFilesWithStore(files, (type, data) => this.storeObject(repo, type, data));
    const commitSha = this.makeCommit(repo, tree, tip !== undefined ? [tip] : [], opts.message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { status: isCreate ? 201 : 200, commitSha, contentSha };
  }

  getContent(
    repo: Repo,
    path: string,
    ref?: string,
  ): { status: 200; entry: ContentFile | ContentDirEntry[] } | { status: 404; message: string } {
    const tip = ref !== undefined ? this.resolveRef(repo, ref) : this.defaultTip(repo);
    if (tip === undefined) return { status: 404, message: 'Not Found' };
    const commit = repo.objects.get(tip);
    if (commit === undefined || commit.type !== 'commit') return { status: 404, message: 'Not Found' };
    const treeOid = parseCommit(commit.data).tree;
    const segments = path.split('/').filter((s) => s !== '');
    if (segments.length === 0) {
      return { status: 200, entry: this.dirEntries(repo, treeOid, '') };
    }
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return { status: 404, message: 'Not Found' };
      const entry = parseTree(object.data).find((e) => e.name === segments[i]);
      if (entry === undefined) return { status: 404, message: 'Not Found' };
      if (i === segments.length - 1) {
        const target = repo.objects.get(entry.oid);
        if (target === undefined) return { status: 404, message: 'Not Found' };
        if (target.type === 'blob') {
          return {
            status: 200,
            entry: {
              type: 'file',
              encoding: 'base64',
              content: target.data.toString('base64'),
              sha: entry.oid,
              size: target.data.length,
              path,
              name: segments[segments.length - 1] as string,
            },
          };
        }
        if (target.type === 'tree') {
          return { status: 200, entry: this.dirEntries(repo, entry.oid, path) };
        }
        return { status: 404, message: 'Not Found' };
      }
      current = entry.oid;
    }
    return { status: 404, message: 'Not Found' };
  }

  private dirEntries(repo: Repo, treeOid: string, basePath: string): ContentDirEntry[] {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return [];
    return parseTree(object.data).map((entry) => ({
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      name: entry.name,
      path: basePath === '' ? entry.name : `${basePath}/${entry.name}`,
      sha: entry.oid,
    }));
  }

  deleteContent(
    repo: Repo,
    opts: { path: string; message: string; sha?: string; branch?: string },
  ): { status: 200; commitSha: string } | { status: 404; message: string } | { status: 409; message: string } {
    const branch = opts.branch ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return { status: 404, message: 'Not Found' };
    const files = this.fileMap(repo, tip);
    const existing = files.get(opts.path);
    if (existing === undefined) return { status: 404, message: 'Not Found' };
    if (opts.sha !== undefined && opts.sha.toLowerCase() !== existing.toLowerCase()) {
      return { status: 409, message: 'sha does not match the current blob' };
    }
    files.delete(opts.path);
    const tree = buildTreeFromFilesWithStore(files, (type, data) => this.storeObject(repo, type, data));
    const commitSha = this.makeCommit(repo, tree, [tip], opts.message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { status: 200, commitSha };
  }

  // ---------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color?: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { name, color: color ?? 'ededed' };
    repo.labels.set(name, label);
    return label;
  }

  // ---------------------------------------------------------------- issues

  createIssue(repo: Repo, opts: { title: string; body?: string; labels?: readonly string[] }): Issue | { status: 422; message: string } {
    const labels: string[] = [];
    for (const name of opts.labels ?? []) {
      if (!repo.labels.has(name)) return { status: 422, message: `label ${JSON.stringify(name)} does not exist` };
      labels.push(name);
    }
    const issue: Issue = {
      kind: 'issue',
      id: this.nextGlobalId,
      number: repo.nextNumber,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      labels,
      comments: [],
      createdSeq: this.seq,
    };
    this.nextGlobalId += 1;
    this.seq += 1;
    repo.nextNumber += 1;
    repo.numbered.push(issue);
    return issue;
  }

  getNumbered(repo: Repo, number: number): Numbered | undefined {
    return repo.numbered.find((item) => item.number === number);
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    const item = this.getNumbered(repo, number);
    return item !== undefined && item.kind === 'issue' ? item : undefined;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    const item = this.getNumbered(repo, number);
    return item !== undefined && item.kind === 'pull' ? item : undefined;
  }

  listIssues(repo: Repo, opts: { state?: string; sort?: string; direction?: string }): Issue[] {
    const state = opts.state ?? 'open';
    let list = repo.numbered.filter((item): item is Issue => item.kind === 'issue');
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    const direction = opts.direction ?? 'desc';
    list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return list;
  }

  setIssueState(repo: Repo, number: number, state: 'open' | 'closed'): Issue | undefined {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) return undefined;
    issue.state = state;
    return issue;
  }

  createComment(repo: Repo, number: number, body: string): Comment | undefined {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) return undefined;
    const comment: Comment = { id: repo.nextCommentId, body };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ---------------------------------------------------------------- pulls

  createPull(
    repo: Repo,
    opts: { head: string; base: string; title: string; body?: string },
  ): Pull | { status: 422; message: string } | { status: 404; message: string } {
    const headSha = this.resolveRef(repo, opts.head);
    const baseSha = this.resolveRef(repo, opts.base);
    if (headSha === undefined || baseSha === undefined) return { status: 404, message: 'Not Found' };
    const existing = repo.numbered.find(
      (item): item is Pull => item.kind === 'pull' && item.state === 'open' && item.head === opts.head && item.base === opts.base,
    );
    if (existing !== undefined) return { status: 422, message: 'A pull request already exists for this head and base' };
    const pull: Pull = {
      kind: 'pull',
      id: this.nextGlobalId,
      number: repo.nextNumber,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      head: opts.head,
      base: opts.base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.seq,
    };
    this.nextGlobalId += 1;
    this.seq += 1;
    repo.nextNumber += 1;
    repo.numbered.push(pull);
    return pull;
  }

  listPulls(repo: Repo, opts: { state?: string }): Pull[] {
    const state = opts.state ?? 'open';
    let list = repo.numbered.filter((item): item is Pull => item.kind === 'pull');
    if (state !== 'all') list = list.filter((pull) => pull.state === state);
    return [...list].sort((a, b) => b.createdSeq - a.createdSeq);
  }

  /** The changed files of a pull request (base tree vs head tree). */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const baseFiles = this.fileMap(repo, pull.baseSha);
    const headFiles = this.fileMap(repo, pull.headSha);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const baseOid = baseFiles.get(path);
      const headOid = headFiles.get(path);
      if (baseOid === headOid) continue;
      if (baseOid === undefined && headOid !== undefined) {
        const blob = repo.objects.get(headOid);
        const additions = blob !== undefined && blob.type === 'blob' ? countLines(blob.data.toString('utf8')) : 0;
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (headOid === undefined && baseOid !== undefined) {
        const blob = repo.objects.get(baseOid);
        const deletions = blob !== undefined && blob.type === 'blob' ? countLines(blob.data.toString('utf8')) : 0;
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (baseOid !== undefined && headOid !== undefined) {
        const oldBlob = repo.objects.get(baseOid);
        const newBlob = repo.objects.get(headOid);
        const [additions, deletions] = lineDiff(
          oldBlob !== undefined && oldBlob.type === 'blob' ? oldBlob.data.toString('utf8') : '',
          newBlob !== undefined && newBlob.type === 'blob' ? newBlob.data.toString('utf8') : '',
        );
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Is the pull request mergeable right now (three-way file merge clean)? */
  mergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    return this.threeWayMerge(repo, pull) !== null;
  }

  private threeWayMerge(repo: Repo, pull: Pull): Map<string, string> | null {
    const base = this.mergeBase(repo, pull.headSha, pull.baseSha);
    const baseFiles = base !== null ? this.fileMap(repo, base) : new Map<string, string>();
    const oursFiles = this.fileMap(repo, pull.baseSha);
    const headFiles = this.fileMap(repo, pull.headSha);
    const merged = new Map<string, string>();
    const paths = new Set([...baseFiles.keys(), ...oursFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const b = baseFiles.get(path);
      const o = oursFiles.get(path);
      const t = headFiles.get(path);
      if (o === t) {
        if (o !== undefined) merged.set(path, o);
      } else if (o === b) {
        if (t !== undefined) merged.set(path, t);
      } else if (t === b) {
        if (o !== undefined) merged.set(path, o);
      } else {
        return null; // both sides changed it differently: conflict
      }
    }
    return merged;
  }

  mergePull(
    repo: Repo,
    number: number,
    method: string,
  ): { status: 200; sha: string; message: string } | { status: 404; message: string } | { status: 405; message: string } {
    const pull = this.getPull(repo, number);
    if (pull === undefined) return { status: 404, message: 'Not Found' };
    if (pull.state !== 'open') return { status: 405, message: 'Pull request is already closed' };
    if (method !== '' && method !== 'squash' && method !== 'merge' && method !== 'rebase') {
      return { status: 405, message: `merge method ${JSON.stringify(method)} is not supported` };
    }
    // Refresh the head/base tips (branches may have moved since creation).
    const headSha = this.resolveRef(repo, pull.head) ?? pull.headSha;
    const baseSha = this.resolveRef(repo, pull.base) ?? pull.baseSha;
    pull.headSha = headSha;
    pull.baseSha = baseSha;
    const merged = this.threeWayMerge(repo, pull);
    if (merged === null) return { status: 405, message: 'Merge conflict' };
    const tree = buildTreeFromFilesWithStore(merged, (type, data) => this.storeObject(repo, type, data));
    const message = `Merge pull request #${pull.number} from ${pull.head}`;
    const sha = this.makeCommit(repo, tree, [baseSha], pull.title === '' ? message : pull.title);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = trialNowIso();
    pull.mergeCommitSha = sha;
    pull.baseSha = sha;
    return { status: 200, sha, message };
  }

  // ---------------------------------------------------------------- global ids

  /** The opaque Relay id of a repo/issue/pull/comment. Never the plain number. */
  globalId(repo: Repo, item: Numbered | Comment, parentNumber?: number): string {
    if ('kind' in item) {
      if (item.kind === 'issue') return `I${repo.databaseId}_${item.number}`;
      return `P${repo.databaseId}_${item.number}`;
    }
    return `C${repo.databaseId}_${parentNumber ?? 0}_${item.id}`;
  }

  repoGlobalId(repo: Repo): string {
    return `R${repo.databaseId}`;
  }

  /** Decode a global id back to its repo + kind + number. */
  decodeGlobalId(id: string): { repo: Repo; kind: 'repo' | 'issue' | 'pull' | 'comment'; number: number; commentId: number } | null {
    const repoMatch = /^R(\d+)$/.exec(id);
    if (repoMatch !== null) {
      const repo = this.repoOrder.find((r) => r.databaseId === Number(repoMatch[1]));
      return repo !== undefined ? { repo, kind: 'repo', number: 0, commentId: 0 } : null;
    }
    const issueMatch = /^I(\d+)_(\d+)$/.exec(id);
    if (issueMatch !== null) {
      const repo = this.repoOrder.find((r) => r.databaseId === Number(issueMatch[1]));
      return repo !== undefined ? { repo, kind: 'issue', number: Number(issueMatch[2]), commentId: 0 } : null;
    }
    const pullMatch = /^P(\d+)_(\d+)$/.exec(id);
    if (pullMatch !== null) {
      const repo = this.repoOrder.find((r) => r.databaseId === Number(pullMatch[1]));
      return repo !== undefined ? { repo, kind: 'pull', number: Number(pullMatch[2]), commentId: 0 } : null;
    }
    const commentMatch = /^C(\d+)_(\d+)_(\d+)$/.exec(id);
    if (commentMatch !== null) {
      const repo = this.repoOrder.find((r) => r.databaseId === Number(commentMatch[1]));
      return repo !== undefined
        ? { repo, kind: 'comment', number: Number(commentMatch[2]), commentId: Number(commentMatch[3]) }
        : null;
    }
    return null;
  }

  /** All objects reachable from a repo's refs (for export/debug only). */
  reachableFromRefs(repo: Repo): Set<string> {
    const tips = [...repo.refs.values()];
    const out = new Set<string>();
    for (const tip of tips) {
      try {
        for (const oid of collectReachable([tip], (oid) => repo.objects.get(oid))) out.add(oid);
      } catch {
        // A ref may point at a tag or a dangling object; skip what is missing.
      }
    }
    return out;
  }
}

export { ZERO_OID, parseTag };
