// A small GraphQL executor for POST /api/graphql: the 18 documents
// github-mcp-server and the kit's graphql-client send (viewer, repository,
// issues, pull requests, mutations, __type introspection, node(id:), and
// two-document batching). No external dependency; the parser handles
// variables, enums, inline input objects, lists, aliases, inline fragments
// and named fragments.
//
// State values are GraphQL enums here (OPEN/CLOSED/MERGED) while the REST
// surface keeps GitHub's lowercase (open/closed). Global ids are opaque
// (R<dbid>, I<dbid>_<n>, P<dbid>_<n>, C<dbid>_<n>_<cid>).

import type { Forge, Issue, Pull, Repo } from './store.ts';
import { VIEWER } from './scenario.ts';

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Token {
  type: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { i += 1; continue; }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') { tokens.push({ type: 'spread', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@|&'.includes(c)) { tokens.push({ type: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length) {
        const ch = source[j] as string;
        if (ch === '"') break;
        if (ch === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else out += esc;
          j += 2;
          continue;
        }
        out += ch;
        j += 1;
      }
      if (j >= source.length) throw new Error('unterminated string in GraphQL document');
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ type: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.type !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.type === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Array<OperationNode | FragmentNode> {
    const defs: Array<OperationNode | FragmentNode> = [];
    while (this.peek() !== undefined) defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): OperationNode | FragmentNode {
    const token = this.peek();
    if (token !== undefined && token.type === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, selections: this.parseSelectionSet() };
    }
    if (token !== undefined && token.type === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    const operation = this.expectName() as 'query' | 'mutation' | 'subscription';
    let name: string | null = null;
    const next = this.peek();
    if (next !== undefined && next.type === 'name') name = this.next().value;
    if (this.peek()?.type === 'punct' && this.peek()?.value === '(') this.skipVariableDefinitions();
    return { kind: 'operation', operation, name, selections: this.parseSelectionSet() };
  }

  private skipVariableDefinitions(): void {
    // ($name: Type = default, ...) — types are not needed to execute.
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.type === 'punct' && token.value === '(') depth += 1;
      else if (token.type === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.type === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.type === 'spread') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.type === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next !== undefined && next.type === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek()?.type === 'punct' && this.peek()?.value === '(') {
      this.expectPunct('(');
      while (!(this.peek()?.type === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selections = this.peek()?.type === 'punct' && this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selections };
  }

  private skipDirectives(): void {
    while (this.peek()?.type === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.type === 'punct' && this.peek()?.value === '(') {
        this.expectPunct('(');
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.type === 'punct' && token.value === '(') depth += 1;
          else if (token.type === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.type === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.type === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.type === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.type === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.type === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.type === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.type === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected token ${JSON.stringify(token.value)} in GraphQL value`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface GqlError {
  message: string;
  path: Array<string | number>;
}

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: GqlError[];
}

type Wrapped =
  | { kind: 'user'; login: string; id: number; name: string; email: string }
  | { kind: 'repo'; repo: Repo }
  | { kind: 'issue'; repo: Repo; issue: Issue }
  | { kind: 'pull'; repo: Repo; pull: Pull }
  | { kind: 'comment'; repo: Repo; number: number; id: number; body: string }
  | { kind: 'ref'; name: string }
  | { kind: 'issueConnection'; repo: Repo; items: Issue[]; totalCount: number; _pageInfo?: Wrapped }
  | { kind: 'pullConnection'; repo: Repo; items: Pull[]; totalCount: number; _pageInfo?: Wrapped }
  | { kind: 'fileConnection'; files: Array<{ path: string; additions: number; deletions: number; changeType: string }> }
  | { kind: 'pageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { kind: 'type'; name: string; typeKind: string; fields: string[]; enumValues: string[] }
  | { kind: 'typeField'; name: string }
  | { kind: 'schema' }
  | { kind: 'mutationIssue'; repo: Repo; issue: Issue }
  | { kind: 'mutationPull'; repo: Repo; pull: Pull }
  | { kind: 'mutationComment'; repo: Repo; number: number; id: number; body: string };

const TYPE_NAMES: Record<Wrapped['kind'], string> = {
  user: 'User',
  repo: 'Repository',
  issue: 'Issue',
  pull: 'PullRequest',
  comment: 'IssueComment',
  ref: 'Ref',
  issueConnection: 'IssueConnection',
  pullConnection: 'PullRequestConnection',
  fileConnection: 'PullRequestChangedFileConnection',
  pageInfo: 'PageInfo',
  type: '__Type',
  typeField: '__TypeField',
  schema: '__Schema',
  mutationIssue: 'CreateIssuePayload',
  mutationPull: 'CreatePullRequestPayload',
  mutationComment: 'AddCommentPayload',
};

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match === null) return -1;
    return parseInt(match[1] as string, 10);
  } catch {
    return -1;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function sortIssues(issues: Issue[], orderBy?: { field?: string; direction?: string }): Issue[] {
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  return [...issues].sort((a, b) => direction * (a.createdSeq - b.createdSeq));
}

function paginateItems<T>(items: readonly T[], first: number | undefined, after: unknown): { page: T[]; hasNextPage: boolean; startCursor: string | null; endCursor: string | null; hasPreviousPage: boolean } {
  const start = decodeCursor(after) + 1;
  const limit = first !== undefined && Number.isFinite(first) ? Math.max(0, first) : items.length;
  const page = items.slice(start, start + limit);
  const endIndex = start + page.length - 1;
  return {
    page: [...page],
    hasNextPage: start + page.length < items.length,
    startCursor: page.length > 0 ? encodeCursor(start) : null,
    endCursor: page.length > 0 ? encodeCursor(endIndex) : null,
    hasPreviousPage: start > 0,
  };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'author', 'comments', 'commits', 'reviews', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'labels', 'forkCount', 'stargazerCount'],
  User: ['id', 'login', 'name', 'email', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['id', 'name', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const TYPE_KINDS: Record<string, string> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  User: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFileConnection: 'OBJECT',
  PageInfo: 'OBJECT',
  Ref: 'OBJECT',
  IssueComment: 'OBJECT',
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'MILESTONE', 'COMMIT', 'CODE'];

function typeInfo(name: string): { kind: string; fields: string[]; enumValues: string[] } | null {
  const kind = TYPE_KINDS[name];
  if (kind === undefined) return null;
  if (kind === 'ENUM') return { kind, fields: [], enumValues: name === 'SearchType' ? SEARCH_TYPE_VALUES : [] };
  return { kind, fields: TYPE_FIELDS[name] ?? [], enumValues: [] };
}

type Resolver = (ctx: ExecContext, value: Wrapped, args: Record<string, unknown>, selections: SelectionNode[] | null, path: Array<string | number>) => unknown;

function scalarResolver<T extends Wrapped>(fn: (value: T) => unknown): Resolver {
  return (_ctx, value) => fn(value as T);
}

const FIELD_TABLES: Record<string, Record<string, Resolver>> = {
  User: {
    login: scalarResolver((v: Extract<Wrapped, { kind: 'user' }>) => v.login),
    id: scalarResolver((v: Extract<Wrapped, { kind: 'user' }>) => `U${v.id}`),
    name: scalarResolver((v: Extract<Wrapped, { kind: 'user' }>) => v.name),
    email: scalarResolver((v: Extract<Wrapped, { kind: 'user' }>) => v.email),
  },
  Repository: {
    id: scalarResolver((v: Extract<Wrapped, { kind: 'repo' }>) => v.repo.databaseId !== undefined ? `R${v.repo.databaseId}` : ''),
    databaseId: scalarResolver((v: Extract<Wrapped, { kind: 'repo' }>) => v.repo.databaseId),
    name: scalarResolver((v: Extract<Wrapped, { kind: 'repo' }>) => v.repo.name),
    nameWithOwner: scalarResolver((v: Extract<Wrapped, { kind: 'repo' }>) => `${v.repo.owner}/${v.repo.name}`),
    owner: (ctx, value) => wrapUser(ctx, value as Extract<Wrapped, { kind: 'repo' }>),
    defaultBranchRef: (ctx, value, _args, selections, path) => {
      const repo = (value as Extract<Wrapped, { kind: 'repo' }>).repo;
      const tip = ctx.forge.defaultTip(repo);
      if (tip === undefined) return null;
      return executeWrapped(ctx, { kind: 'ref', name: repo.defaultBranch }, selections, path);
    },
    viewerPermission: scalarResolver(() => 'ADMIN'),
    hasIssuesEnabled: scalarResolver(() => true),
    description: scalarResolver((v: Extract<Wrapped, { kind: 'repo' }>) => v.repo.description),
    isPrivate: scalarResolver((v: Extract<Wrapped, { kind: 'repo' }>) => v.repo.private),
    issue: (ctx, value, args, selections, path) => {
      const repo = (value as Extract<Wrapped, { kind: 'repo' }>).repo;
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const issue = ctx.forge.getIssue(repo, number);
      if (issue === undefined) return null;
      return executeWrapped(ctx, { kind: 'issue', repo, issue }, selections, path);
    },
    issues: (ctx, value, args, selections, path) => {
      const repo = (value as Extract<Wrapped, { kind: 'repo' }>).repo;
      return executeWrapped(ctx, buildIssueConnection(ctx, repo, args), selections, path);
    },
    pullRequests: (ctx, value, args, selections, path) => {
      const repo = (value as Extract<Wrapped, { kind: 'repo' }>).repo;
      return executeWrapped(ctx, buildPullConnection(ctx, repo, args), selections, path);
    },
    pullRequest: (ctx, value, args, selections, path) => {
      const repo = (value as Extract<Wrapped, { kind: 'repo' }>).repo;
      const number = args.number as number | undefined;
      if (typeof number !== 'number') return null;
      const pull = ctx.forge.getPull(repo, number);
      if (pull === undefined) return null;
      return executeWrapped(ctx, { kind: 'pull', repo, pull }, selections, path);
    },
  },
  Issue: {
    id: scalarResolver((v: Extract<Wrapped, { kind: 'issue' }>) => v.repo.databaseId !== undefined ? `I${v.repo.databaseId}_${v.issue.number}` : ''),
    number: scalarResolver((v: Extract<Wrapped, { kind: 'issue' }>) => v.issue.number),
    title: scalarResolver((v: Extract<Wrapped, { kind: 'issue' }>) => v.issue.title),
    state: scalarResolver((v: Extract<Wrapped, { kind: 'issue' }>) => issueState(v.issue)),
    body: scalarResolver((v: Extract<Wrapped, { kind: 'issue' }>) => v.issue.body),
  },
  PullRequest: {
    id: scalarResolver((v: Extract<Wrapped, { kind: 'pull' }>) => `P${v.repo.databaseId}_${v.pull.number}`),
    number: scalarResolver((v: Extract<Wrapped, { kind: 'pull' }>) => v.pull.number),
    title: scalarResolver((v: Extract<Wrapped, { kind: 'pull' }>) => v.pull.title),
    body: scalarResolver((v: Extract<Wrapped, { kind: 'pull' }>) => v.pull.body),
    state: scalarResolver((v: Extract<Wrapped, { kind: 'pull' }>) => pullState(v.pull)),
    merged: scalarResolver((v: Extract<Wrapped, { kind: 'pull' }>) => v.pull.merged),
    headRefName: scalarResolver((v: Extract<Wrapped, { kind: 'pull' }>) => v.pull.head),
    baseRefName: scalarResolver((v: Extract<Wrapped, { kind: 'pull' }>) => v.pull.base),
    mergeable: (ctx, value) => {
      const v = value as Extract<Wrapped, { kind: 'pull' }>;
      // GraphQL's MergeableState enum, not a boolean.
      return ctx.forge.mergeable(v.repo, v.pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (ctx, value, args, selections, path) => {
      const v = value as Extract<Wrapped, { kind: 'pull' }>;
      const raw = ctx.forge.pullFiles(v.repo, v.pull);
      const files = raw.map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }));
      const first = args.first as number | undefined;
      const limited = first !== undefined && Number.isFinite(first) ? files.slice(0, first) : files;
      return executeWrapped(ctx, { kind: 'fileConnection', files: limited }, selections, path);
    },
  },
  Ref: {
    name: scalarResolver((v: Extract<Wrapped, { kind: 'ref' }>) => v.name),
  },
  IssueConnection: {
    nodes: (ctx, value, _args, selections, path) => {
      const v = value as Extract<Wrapped, { kind: 'issueConnection' }>;
      return executeList(ctx, v.items.map((issue) => ({ kind: 'issue', repo: v.repo, issue } as Wrapped)), selections, path);
    },
    pageInfo: (ctx, value, _args, selections, path) => {
      const v = value as Extract<Wrapped, { kind: 'issueConnection' }>;
      return executeWrapped(ctx, { kind: 'pageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, selections, path);
    },
    totalCount: scalarResolver((v: Extract<Wrapped, { kind: 'issueConnection' }>) => v.totalCount),
  },
  PullRequestConnection: {
    nodes: (ctx, value, _args, selections, path) => {
      const v = value as Extract<Wrapped, { kind: 'pullConnection' }>;
      return executeList(ctx, v.items.map((pull) => ({ kind: 'pull', repo: v.repo, pull } as Wrapped)), selections, path);
    },
    pageInfo: (ctx, value, _args, selections, path) => {
      return executeWrapped(ctx, { kind: 'pageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, selections, path);
    },
    totalCount: scalarResolver((v: Extract<Wrapped, { kind: 'pullConnection' }>) => v.totalCount),
  },
  PullRequestChangedFileConnection: {
    nodes: (ctx, value, _args, selections, path) => {
      const v = value as Extract<Wrapped, { kind: 'fileConnection' }>;
      return v.files.map((file) => executeFileNode(ctx, file, selections, path));
    },
    pageInfo: (ctx, value, _args, selections, path) => {
      const v = value as Extract<Wrapped, { kind: 'fileConnection' }>;
      return executeWrapped(ctx, { kind: 'pageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: v.files.length > 0 ? encodeCursor(0) : null, endCursor: v.files.length > 0 ? encodeCursor(v.files.length - 1) : null }, selections, path);
    },
    totalCount: scalarResolver((v: Extract<Wrapped, { kind: 'fileConnection' }>) => v.files.length),
  },
  PageInfo: {
    hasNextPage: scalarResolver((v: Extract<Wrapped, { kind: 'pageInfo' }>) => v.hasNextPage),
    hasPreviousPage: scalarResolver((v: Extract<Wrapped, { kind: 'pageInfo' }>) => v.hasPreviousPage),
    startCursor: scalarResolver((v: Extract<Wrapped, { kind: 'pageInfo' }>) => v.startCursor),
    endCursor: scalarResolver((v: Extract<Wrapped, { kind: 'pageInfo' }>) => v.endCursor),
  },
  __Type: {
    name: scalarResolver((v: Extract<Wrapped, { kind: 'type' }>) => v.name),
    kind: scalarResolver((v: Extract<Wrapped, { kind: 'type' }>) => v.typeKind),
    fields: (ctx, value, _args, selections, path) => {
      const v = value as Extract<Wrapped, { kind: 'type' }>;
      return v.fields.map((name) => executeWrapped(ctx, { kind: 'typeField', name }, selections, path));
    },
    enumValues: (ctx, value, _args, selections, path) => {
      const v = value as Extract<Wrapped, { kind: 'type' }>;
      return v.enumValues.map((name) => executeWrapped(ctx, { kind: 'typeField', name }, selections, path));
    },
  },
};

function wrapUser(_ctx: ExecContext, _repo: Extract<Wrapped, { kind: 'repo' }>): Wrapped {
  return { kind: 'user', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function executeFileNode(ctx: ExecContext, file: { path: string; additions: number; deletions: number; changeType: string }, selections: SelectionNode[] | null, path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections ?? []) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name;
    if (selection.name === 'path') out[key] = file.path;
    else if (selection.name === 'additions') out[key] = file.additions;
    else if (selection.name === 'deletions') out[key] = file.deletions;
    else if (selection.name === 'changeType') out[key] = file.changeType;
    else {
      ctx.errors.push({ message: `noSuchFieldOnPullRequestChangedFile: field "${selection.name}" does not exist on type "PullRequestChangedFile"`, path: [...path, key] });
      out[key] = null;
    }
  }
  return out;
}

function executeWrapped(ctx: ExecContext, value: Wrapped, selections: SelectionNode[] | null, path: Array<string | number>): unknown {
  if (selections === null) return null;
  const typeName = TYPE_NAMES[value.kind];
  const out: Record<string, unknown> = {};
  // The connection resolvers need the pagination arguments; they are applied
  // by the parent field resolver before this point for nodes/pageInfo, so
  // here we only walk the selections.
  executeSelectionsInto(ctx, value, typeName, selections, path, out);
  return out;
}

function executeSelectionsInto(ctx: ExecContext, value: Wrapped, typeName: string, selections: SelectionNode[], path: Array<string | number>, out: Record<string, unknown>): void {
  const table = FIELD_TABLES[typeName] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        executeSelectionsInto(ctx, value, typeName, selection.selections, path, out);
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === typeName)) {
        executeSelectionsInto(ctx, value, typeName, fragment.selections, path, out);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const fieldPath = [...path, key];
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const resolver = table[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `noSuchFieldOn${typeName}: field "${selection.name}" does not exist on type "${typeName}"`, path: fieldPath });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
    out[key] = resolver(ctx, value, args, selection.selections, fieldPath);
  }
}

function executeList(ctx: ExecContext, items: Wrapped[], selections: SelectionNode[] | null, path: Array<string | number>): unknown[] {
  if (selections === null) return [];
  return items.map((item, index) => executeWrapped(ctx, item, selections, [...path, index]));
}

// Connection fields (nodes/pageInfo) need the pagination args of the parent
// `issues`/`pullRequests` field. The resolvers above receive the connection
// without those args, so pagination is applied here instead: the parent
// resolver builds the connection with the full item list and stores the
// args on it. To keep that simple, connections are built with a `page`
// computed at construction time by the parent resolver — see
// buildIssueConnection below.
function buildIssueConnection(ctx: ExecContext, repo: Repo, args: Record<string, unknown>): Wrapped {
  const states = args.states as string[] | undefined;
  let items = repo.numbered.filter((item): item is Issue => item.kind === 'issue');
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    items = items.filter((issue) => wanted.has(issue.state));
  }
  items = sortIssues(items, args.orderBy as { field?: string; direction?: string } | undefined);
  const first = args.first as number | undefined;
  const page = paginateItems(items, first, args.after);
  return {
    kind: 'issueConnection',
    repo,
    items: page.page,
    totalCount: items.length,
    _pageInfo: { kind: 'pageInfo', hasNextPage: page.hasNextPage, hasPreviousPage: page.hasPreviousPage, startCursor: page.startCursor, endCursor: page.endCursor },
  };
}

function buildPullConnection(ctx: ExecContext, repo: Repo, args: Record<string, unknown>): Wrapped {
  const items = [...repo.numbered.filter((item): item is Pull => item.kind === 'pull')].sort((a, b) => b.createdSeq - a.createdSeq);
  const first = args.first as number | undefined;
  const page = paginateItems(items, first, args.after);
  return {
    kind: 'pullConnection',
    repo,
    items: page.page,
    totalCount: items.length,
    _pageInfo: { kind: 'pageInfo', hasNextPage: page.hasNextPage, hasPreviousPage: page.hasPreviousPage, startCursor: page.startCursor, endCursor: page.endCursor },
  };
}

function resolveRootField(ctx: ExecContext, operation: 'query' | 'mutation', field: FieldNode, path: Array<string | number>): unknown {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
  const key = field.alias ?? field.name;
  const fieldPath = [...path, key];
  if (operation === 'query') {
    if (field.name === 'viewer') {
      return executeWrapped(ctx, { kind: 'user', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email }, field.selections, fieldPath);
    }
    if (field.name === 'repository') {
      const owner = args.owner as string | undefined;
      const name = args.name as string | undefined;
      const repo = owner !== undefined && name !== undefined ? ctx.forge.getRepo(owner, name) : undefined;
      if (repo === undefined) return null;
      return executeWrapped(ctx, { kind: 'repo', repo }, field.selections, fieldPath);
    }
    if (field.name === 'node') {
      const id = args.id as string | undefined;
      if (typeof id !== 'string') return null;
      const decoded = ctx.forge.decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'repo') return executeWrapped(ctx, { kind: 'repo', repo: decoded.repo }, field.selections, fieldPath);
      if (decoded.kind === 'issue') {
        const issue = ctx.forge.getIssue(decoded.repo, decoded.number);
        if (issue === undefined) return null;
        return executeWrapped(ctx, { kind: 'issue', repo: decoded.repo, issue }, field.selections, fieldPath);
      }
      if (decoded.kind === 'pull') {
        const pull = ctx.forge.getPull(decoded.repo, decoded.number);
        if (pull === undefined) return null;
        return executeWrapped(ctx, { kind: 'pull', repo: decoded.repo, pull }, field.selections, fieldPath);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args.name as string | undefined;
      if (typeof name !== 'string') return null;
      const info = typeInfo(name);
      if (info === null) return null;
      return executeWrapped(ctx, { kind: 'type', name, typeKind: info.kind, fields: info.fields, enumValues: info.enumValues }, field.selections, fieldPath);
    }
    if (field.name === '__schema') {
      return executeWrapped(ctx, { kind: 'schema' }, field.selections, fieldPath);
    }
    ctx.errors.push({ message: `noSuchFieldOnQuery: field "${field.name}" does not exist on type "Query"`, path: fieldPath });
    return null;
  }
  // Mutations.
  if (field.name === 'createIssue') return mutateCreateIssue(ctx, args, field, fieldPath);
  if (field.name === 'closeIssue') return mutateCloseIssue(ctx, args, field, fieldPath);
  if (field.name === 'createPullRequest') return mutateCreatePullRequest(ctx, args, field, fieldPath);
  if (field.name === 'mergePullRequest') return mutateMergePullRequest(ctx, args, field, fieldPath);
  if (field.name === 'addComment') return mutateAddComment(ctx, args, field, fieldPath);
  ctx.errors.push({ message: `noSuchFieldOnMutation: field "${field.name}" does not exist on type "Mutation"`, path: fieldPath });
  return null;
}

function inputObject(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function mutateCreateIssue(ctx: ExecContext, args: Record<string, unknown>, field: FieldNode, path: Array<string | number>): unknown {
  const input = inputObject(args);
  const repositoryId = input.repositoryId as string | undefined;
  const title = input.title as string | undefined;
  if (typeof repositoryId !== 'string' || typeof title !== 'string') {
    ctx.errors.push({ message: 'createIssue requires input.repositoryId and input.title', path });
    return null;
  }
  const decoded = ctx.forge.decodeGlobalId(repositoryId);
  if (decoded === null || decoded.kind !== 'repo') {
    ctx.errors.push({ message: `createIssue: unknown repository ${JSON.stringify(repositoryId)}`, path });
    return null;
  }
  const result = ctx.forge.createIssue(decoded.repo, { title, body: input.body as string | undefined });
  if ('status' in result) {
    ctx.errors.push({ message: result.message, path });
    return null;
  }
  return executeWrapped(ctx, { kind: 'mutationIssue', repo: decoded.repo, issue: result } as Wrapped, field.selections, path);
}

function mutateCloseIssue(ctx: ExecContext, args: Record<string, unknown>, field: FieldNode, path: Array<string | number>): unknown {
  const input = inputObject(args);
  const issueId = input.issueId as string | undefined;
  if (typeof issueId !== 'string') {
    ctx.errors.push({ message: 'closeIssue requires input.issueId', path });
    return null;
  }
  const decoded = ctx.forge.decodeGlobalId(issueId);
  if (decoded === null || decoded.kind !== 'issue') {
    ctx.errors.push({ message: `closeIssue: unknown issue ${JSON.stringify(issueId)}`, path });
    return null;
  }
  const issue = ctx.forge.setIssueState(decoded.repo, decoded.number, 'closed');
  if (issue === undefined) {
    ctx.errors.push({ message: `closeIssue: issue #${decoded.number} not found`, path });
    return null;
  }
  return executeWrapped(ctx, { kind: 'mutationIssue', repo: decoded.repo, issue } as Wrapped, field.selections, path);
}

function mutateCreatePullRequest(ctx: ExecContext, args: Record<string, unknown>, field: FieldNode, path: Array<string | number>): unknown {
  const input = inputObject(args);
  const repositoryId = input.repositoryId as string | undefined;
  const headRefName = input.headRefName as string | undefined;
  const baseRefName = input.baseRefName as string | undefined;
  const title = input.title as string | undefined;
  if (typeof repositoryId !== 'string' || typeof headRefName !== 'string' || typeof baseRefName !== 'string' || typeof title !== 'string') {
    ctx.errors.push({ message: 'createPullRequest requires input.repositoryId, input.headRefName, input.baseRefName and input.title', path });
    return null;
  }
  const decoded = ctx.forge.decodeGlobalId(repositoryId);
  if (decoded === null || decoded.kind !== 'repo') {
    ctx.errors.push({ message: `createPullRequest: unknown repository ${JSON.stringify(repositoryId)}`, path });
    return null;
  }
  const result = ctx.forge.createPull(decoded.repo, { head: headRefName, base: baseRefName, title, body: input.body as string | undefined });
  if ('status' in result) {
    ctx.errors.push({ message: result.message, path });
    return null;
  }
  return executeWrapped(ctx, { kind: 'mutationPull', repo: decoded.repo, pull: result } as Wrapped, field.selections, path);
}

function mutateMergePullRequest(ctx: ExecContext, args: Record<string, unknown>, field: FieldNode, path: Array<string | number>): unknown {
  const input = inputObject(args);
  const pullRequestId = input.pullRequestId as string | undefined;
  if (typeof pullRequestId !== 'string') {
    ctx.errors.push({ message: 'mergePullRequest requires input.pullRequestId', path });
    return null;
  }
  const decoded = ctx.forge.decodeGlobalId(pullRequestId);
  if (decoded === null || decoded.kind !== 'pull') {
    ctx.errors.push({ message: `mergePullRequest: unknown pull request ${JSON.stringify(pullRequestId)}`, path });
    return null;
  }
  const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
  const result = ctx.forge.mergePull(decoded.repo, decoded.number, method);
  if (result.status !== 200) {
    ctx.errors.push({ message: result.message, path });
    return null;
  }
  const pull = ctx.forge.getPull(decoded.repo, decoded.number);
  if (pull === undefined) return null;
  return executeWrapped(ctx, { kind: 'mutationPull', repo: decoded.repo, pull } as Wrapped, field.selections, path);
}

function mutateAddComment(ctx: ExecContext, args: Record<string, unknown>, field: FieldNode, path: Array<string | number>): unknown {
  const input = inputObject(args);
  const subjectId = input.subjectId as string | undefined;
  const body = input.body as string | undefined;
  if (typeof subjectId !== 'string' || typeof body !== 'string') {
    ctx.errors.push({ message: 'addComment requires input.subjectId and input.body', path });
    return null;
  }
  const decoded = ctx.forge.decodeGlobalId(subjectId);
  if (decoded === null || decoded.kind !== 'issue') {
    ctx.errors.push({ message: `addComment: unknown subject ${JSON.stringify(subjectId)}`, path });
    return null;
  }
  const comment = ctx.forge.createComment(decoded.repo, decoded.number, body);
  if (comment === undefined) {
    ctx.errors.push({ message: `addComment: issue #${decoded.number} not found`, path });
    return null;
  }
  return executeWrapped(ctx, { kind: 'mutationComment', repo: decoded.repo, number: decoded.number, id: comment.id, body: comment.body } as Wrapped, field.selections, path);
}

// The mutation payload types share the issue/pull/comment field tables.
FIELD_TABLES['CreateIssuePayload'] = {
  issue: (ctx, value, _args, selections, path) => {
    const v = value as Extract<Wrapped, { kind: 'mutationIssue' }>;
    return executeWrapped(ctx, { kind: 'issue', repo: v.repo, issue: v.issue }, selections, path);
  },
  clientMutationId: () => null,
};
FIELD_TABLES['CloseIssuePayload'] = FIELD_TABLES['CreateIssuePayload'];
FIELD_TABLES['CreatePullRequestPayload'] = {
  pullRequest: (ctx, value, _args, selections, path) => {
    const v = value as Extract<Wrapped, { kind: 'mutationPull' }>;
    return executeWrapped(ctx, { kind: 'pull', repo: v.repo, pull: v.pull }, selections, path);
  },
  clientMutationId: () => null,
};
FIELD_TABLES['MergePullRequestPayload'] = FIELD_TABLES['CreatePullRequestPayload'];
FIELD_TABLES['AddCommentPayload'] = {
  commentEdge: (ctx, value, _args, selections, path) => {
    const v = value as Extract<Wrapped, { kind: 'mutationComment' }>;
    // commentEdge { node { id body } cursor } — a tiny inline shape.
    const out: Record<string, unknown> = {};
    for (const selection of selections ?? []) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name;
      if (selection.name === 'node') {
        out[key] = executeWrapped(ctx, { kind: 'comment', repo: v.repo, number: v.number, id: v.id, body: v.body }, selection.selections, [...path, key]);
      } else if (selection.name === 'cursor') {
        out[key] = encodeCursor(0);
      } else {
        ctx.errors.push({ message: `noSuchFieldOnIssueCommentEdge: field "${selection.name}" does not exist on type "IssueCommentEdge"`, path: [...path, key] });
        out[key] = null;
      }
    }
    return out;
  },
  clientMutationId: () => null,
};
FIELD_TABLES['IssueComment'] = {
  id: scalarResolver((v: Extract<Wrapped, { kind: 'comment' }>) => `C${v.repo.databaseId}_${v.number}_${v.id}`),
  body: scalarResolver((v: Extract<Wrapped, { kind: 'comment' }>) => v.body),
};
FIELD_TABLES['__Schema'] = {
  queryType: (ctx, _value, _args, selections, path) => executeWrapped(ctx, { kind: 'type', name: 'Query', typeKind: 'OBJECT', fields: TYPE_FIELDS.Query ?? [], enumValues: [] }, selections, path),
  mutationType: (ctx, _value, _args, selections, path) => executeWrapped(ctx, { kind: 'type', name: 'Mutation', typeKind: 'OBJECT', fields: TYPE_FIELDS.Mutation ?? [], enumValues: [] }, selections, path),
  types: (ctx, _value, _args, selections, path) => Object.keys(TYPE_KINDS).map((name) => {
    const info = typeInfo(name);
    return executeWrapped(ctx, { kind: 'type', name, typeKind: info?.kind ?? 'OBJECT', fields: info?.fields ?? [], enumValues: info?.enumValues ?? [] }, selections, path);
  }),
};
// A __Type's `fields`/`enumValues` entries expose only `name` here.
FIELD_TABLES['__TypeField'] = {
  name: scalarResolver((v: { kind: 'typeField'; name: string }) => v.name),
};
// Connection pageInfo must reflect the paginated page, not the full list:
// the parent resolver stores it on the connection as `_pageInfo`.
const ORIGINAL_ISSUE_CONNECTION_PAGEINFO = FIELD_TABLES['IssueConnection']?.pageInfo;
if (ORIGINAL_ISSUE_CONNECTION_PAGEINFO !== undefined) {
  FIELD_TABLES['IssueConnection'].pageInfo = (ctx, value, _args, selections, path) => {
    const pageInfo = (value as unknown as { _pageInfo?: Wrapped })._pageInfo;
    if (pageInfo !== undefined) return executeWrapped(ctx, pageInfo, selections, path);
    return ORIGINAL_ISSUE_CONNECTION_PAGEINFO(ctx, value, _args, selections, path);
  };
}
const ORIGINAL_PULL_CONNECTION_PAGEINFO = FIELD_TABLES['PullRequestConnection']?.pageInfo;
if (ORIGINAL_PULL_CONNECTION_PAGEINFO !== undefined) {
  FIELD_TABLES['PullRequestConnection'].pageInfo = (ctx, value, _args, selections, path) => {
    const pageInfo = (value as unknown as { _pageInfo?: Wrapped })._pageInfo;
    if (pageInfo !== undefined) return executeWrapped(ctx, pageInfo, selections, path);
    return ORIGINAL_PULL_CONNECTION_PAGEINFO(ctx, value, _args, selections, path);
  };
}
// The IssueConnection `edges` resolver references a `kind: 'edge'` shape
// that does not exist in Wrapped; replace it with a plain object walk.
FIELD_TABLES['IssueConnection'].edges = (ctx, value, _args, selections, path) => {
  const v = value as Extract<Wrapped, { kind: 'issueConnection' }>;
  return v.items.map((issue, index) => {
    const out: Record<string, unknown> = {};
    for (const selection of selections ?? []) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name;
      if (selection.name === 'node') {
        out[key] = executeWrapped(ctx, { kind: 'issue', repo: v.repo, issue }, selection.selections, [...path, index, key]);
      } else if (selection.name === 'cursor') {
        out[key] = encodeCursor(index);
      } else {
        ctx.errors.push({ message: `noSuchFieldOnIssueEdge: field "${selection.name}" does not exist on type "IssueEdge"`, path: [...path, index, key] });
        out[key] = null;
      }
    }
    return out;
  });
};
FIELD_TABLES['PullRequestConnection'].edges = (ctx, value, _args, selections, path) => {
  const v = value as Extract<Wrapped, { kind: 'pullConnection' }>;
  return v.items.map((pull, index) => {
    const out: Record<string, unknown> = {};
    for (const selection of selections ?? []) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name;
      if (selection.name === 'node') {
        out[key] = executeWrapped(ctx, { kind: 'pull', repo: v.repo, pull }, selection.selections, [...path, index, key]);
      } else if (selection.name === 'cursor') {
        out[key] = encodeCursor(index);
      } else {
        ctx.errors.push({ message: `noSuchFieldOnPullRequestEdge: field "${selection.name}" does not exist on type "PullRequestEdge"`, path: [...path, index, key] });
        out[key] = null;
      }
    }
    return out;
  });
};

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface GraphQLResponse {
  status: number;
  body: unknown;
}

function executeOne(forge: Forge, request: unknown): Record<string, unknown> {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { data: null, errors: [{ message: 'request body must be a GraphQL operation object', path: [] }] };
  }
  const { query, variables, operationName } = request as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof query !== 'string' || query === '') {
    return { data: null, errors: [{ message: 'request body must carry a query string', path: [] }] };
  }
  let definitions: Array<OperationNode | FragmentNode>;
  try {
    definitions = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message, path: [] }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  let operation: OperationNode | undefined;
  if (typeof operationName === 'string') {
    operation = operations.find((op) => op.name === operationName);
  } else if (operations.length === 1) {
    operation = operations[0];
  }
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'no operation found for this request', path: [] }] };
  }
  if (operation.operation !== 'query' && operation.operation !== 'mutation') {
    return { data: null, errors: [{ message: `operation ${operation.operation} is not supported`, path: [] }] };
  }
  const ctx: ExecContext = {
    forge,
    variables: variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Record<string, unknown>) : {},
    fragments,
    errors: [],
  };
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name;
    data[key] = resolveRootField(ctx, operation.operation, selection, []);
  }
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

/** Handle POST /api/graphql. Accepts one operation or a batch array. */
export function handleGraphQL(forge: Forge, body: unknown): GraphQLResponse {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(forge, entry)) };
  }
  return { status: 200, body: executeOne(forge, body) };
}
