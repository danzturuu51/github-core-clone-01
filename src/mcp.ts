// MCP (Model Context Protocol) over Streamable HTTP at POST /mcp.
// Modern era 2026-07-28 (`server/discover`, no session) with the legacy
// `initialize` handshake as a fallback. Plain JSON answers, never SSE.
//
// Tools follow github-mcp-server's documented argument names, so the
// kit's mcp-client maps its calls straight onto them. Tool results carry
// the object as `structuredContent` and the same JSON as a text block.

import type { Forge, Repo } from './store.ts';
import { VIEWER } from './scenario.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_comment',
    description: 'Create a comment on an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
        body: { type: 'string', description: 'The comment body.' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function findTool(name: string): ToolDef | undefined {
  const normalized = name.trim().toLowerCase();
  const exact = TOOLS.find((tool) => tool.name === normalized);
  if (exact !== undefined) return exact;
  // Suffix match, case-insensitive (a prefixed server name is allowed).
  return TOOLS.find((tool) => normalized === tool.name || normalized.endsWith(`_${tool.name}`) || normalized.endsWith(tool.name));
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return undefined;
}

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: forge.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

class ToolError extends Error {}

function requireRepo(forge: Forge, args: Record<string, unknown>): Repo {
  const owner = asString(args.owner);
  const repoName = asString(args.repo) ?? asString(args.repository);
  if (owner === undefined || repoName === undefined) throw new ToolError('owner and repo are required');
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) throw new ToolError(`repository ${owner}/${repoName} not found`);
  return repo;
}

function toolResult(structured: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown } {
  const text = JSON.stringify(structured);
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function runTool(forge: Forge, name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; structuredContent: unknown; isError?: boolean } {
  const tool = findTool(name);
  if (tool === undefined) throw new ToolError(`unknown tool ${JSON.stringify(name)}`);
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    return { content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }], structuredContent: null, isError: true };
  }
  try {
    switch (tool.name) {
      case 'create_repo': {
        const repoName = asString(args.name) as string;
        const repo = forge.createRepo(repoName, {
          description: asString(args.description) ?? '',
          private: typeof args.private === 'boolean' ? args.private : false,
        });
        if (repo === null) throw new ToolError(`repository ${VIEWER.login}/${repoName} already exists`);
        return toolResult(repoJson(forge, repo));
      }
      case 'get_repo': {
        return toolResult(repoJson(forge, requireRepo(forge, args)));
      }
      case 'list_repos': {
        return toolResult({ repositories: forge.listRepos().map((repo) => repoJson(forge, repo)) });
      }
      case 'create_issue': {
        const repo = requireRepo(forge, args);
        const title = asString(args.title) as string;
        const result = forge.createIssue(repo, { title, body: asString(args.body) });
        if ('status' in result) throw new ToolError(result.message);
        return toolResult({
          id: result.id,
          node_id: forge.globalId(repo, result),
          number: result.number,
          title: result.title,
          body: result.body,
          state: result.state,
        });
      }
      case 'get_issue': {
        const repo = requireRepo(forge, args);
        const number = asNumber(args.issue_number);
        const issue = number !== undefined ? forge.getIssue(repo, number) : undefined;
        if (issue === undefined) throw new ToolError(`issue #${String(number ?? '?')} not found`);
        return toolResult({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state });
      }
      case 'list_issues': {
        const repo = requireRepo(forge, args);
        const state = asString(args.state)?.toLowerCase() ?? 'open';
        const issues = forge.listIssues(repo, { state });
        return toolResult({
          issues: issues.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state })),
        });
      }
      case 'create_comment': {
        const repo = requireRepo(forge, args);
        const number = asNumber(args.issue_number);
        const body = asString(args.body) as string;
        const comment = number !== undefined ? forge.createComment(repo, number, body) : undefined;
        if (comment === undefined) throw new ToolError(`issue #${String(number ?? '?')} not found`);
        return toolResult({ id: comment.id, body: comment.body, issue_number: number });
      }
      case 'close_issue': {
        const repo = requireRepo(forge, args);
        const number = asNumber(args.issue_number);
        const issue = number !== undefined ? forge.setIssueState(repo, number, 'closed') : undefined;
        if (issue === undefined) throw new ToolError(`issue #${String(number ?? '?')} not found`);
        return toolResult({ id: issue.id, number: issue.number, title: issue.title, state: issue.state });
      }
      case 'create_pull_request': {
        const repo = requireRepo(forge, args);
        const result = forge.createPull(repo, {
          head: asString(args.head) as string,
          base: asString(args.base) as string,
          title: asString(args.title) as string,
          body: asString(args.body),
        });
        if ('status' in result) throw new ToolError(result.message);
        return toolResult({
          id: result.id,
          node_id: forge.globalId(repo, result),
          number: result.number,
          title: result.title,
          body: result.body,
          state: result.state,
          head: { ref: result.head, sha: result.headSha },
          base: { ref: result.base, sha: result.baseSha },
        });
      }
      case 'list_pull_requests': {
        const repo = requireRepo(forge, args);
        const state = asString(args.state)?.toLowerCase() ?? 'open';
        const pulls = forge.listPulls(repo, { state });
        return toolResult({
          pull_requests: pulls.map((pull) => ({ id: pull.id, number: pull.number, title: pull.title, state: pull.state, merged: pull.merged, head: { ref: pull.head, sha: pull.headSha }, base: { ref: pull.base, sha: pull.baseSha } })),
        });
      }
      case 'merge_pull_request': {
        const repo = requireRepo(forge, args);
        const number = asNumber(args.pull_number);
        if (number === undefined) throw new ToolError('pull_number is required');
        const result = forge.mergePull(repo, number, 'squash');
        if (result.status !== 200) throw new ToolError(result.message);
        return toolResult({ number, merged: true, state: 'closed', sha: result.sha });
      }
      default:
        throw new ToolError(`tool ${tool.name} is not implemented`);
    }
  } catch (err) {
    if (err instanceof ToolError) {
      return { content: [{ type: 'text', text: err.message }], structuredContent: null, isError: true };
    }
    throw err;
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: data !== undefined ? { code, message, data } : { code, message } };
}

const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION };

function handleOne(forge: Forge, request: unknown): JsonRpcResponse | null {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = request as { id?: unknown; method?: unknown; params?: unknown };
  const rpcId: string | number | null = typeof id === 'string' || typeof id === 'number' ? id : null;
  const isNotification = id === undefined;
  if (typeof method !== 'string') return rpcError(rpcId, -32600, 'Invalid Request: method is required');
  if (method === 'server/discover') {
    return rpcResult(rpcId, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { ...SERVER_INFO },
      _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
    });
  }
  if (method === 'initialize') {
    const requested = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
    const protocolVersion = typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[1] as string;
    return rpcResult(rpcId, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { ...SERVER_INFO },
    });
  }
  if (method === 'ping') return rpcResult(rpcId, {});
  if (method.startsWith('notifications/')) return null; // notification: no reply
  if (isNotification) return null;
  if (method === 'tools/list') {
    // A constant structure, so two calls answer byte-for-byte identically.
    return rpcResult(rpcId, { tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
  }
  if (method === 'tools/call') {
    const callParams = (params !== null && typeof params === 'object' && !Array.isArray(params) ? params : {}) as { name?: unknown; arguments?: unknown };
    const toolName = typeof callParams.name === 'string' ? callParams.name : '';
    const args = callParams.arguments !== null && typeof callParams.arguments === 'object' && !Array.isArray(callParams.arguments)
      ? (callParams.arguments as Record<string, unknown>)
      : {};
    if (findTool(toolName) === undefined) {
      return rpcError(rpcId, -32602, `unknown tool ${JSON.stringify(toolName)}`);
    }
    try {
      const result = runTool(forge, toolName, args);
      return rpcResult(rpcId, result);
    } catch (err) {
      return rpcError(rpcId, -32603, (err as Error).message);
    }
  }
  return rpcError(rpcId, -32601, `method not found: ${method}`);
}

export interface McpResponse {
  status: number;
  body: Buffer | null;
}

/** Handle POST /mcp. `rawBody` is the request body bytes; a body that is
 * not JSON answers HTTP 400 with JSON-RPC -32700. */
export function handleMcp(forge: Forge, rawBody: Buffer): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    const response = rpcError(null, -32700, 'Parse error');
    return { status: 400, body: Buffer.from(JSON.stringify(response), 'utf8') };
  }
  if (Array.isArray(parsed)) {
    const responses = parsed.map((entry) => handleOne(forge, entry)).filter((r): r is JsonRpcResponse => r !== null);
    return { status: 200, body: Buffer.from(JSON.stringify(responses), 'utf8') };
  }
  const response = handleOne(forge, parsed);
  if (response === null) return { status: 202, body: null }; // notification
  return { status: 200, body: Buffer.from(JSON.stringify(response), 'utf8') };
}
