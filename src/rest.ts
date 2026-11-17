// GitHub REST API v3 surface, under /api/v3. Every reply is JSON; errors
// are {message}. Repository access is scoped to the token's login: a repo
// under any other owner is a 404, never a 403.
//
// Shapes follow the real GitHub API closely enough for github-mcp-server and
// the kit's rest-client: repo objects carry id/full_name/default_branch,
// issues and pull requests share one per-repo number counter, and the
// contents endpoints behave like GitHub's (201 create / 200 update /
// 409 stale sha).

import { parseCommit } from './gitproto.ts';
import { trialNowIso, VIEWER } from './scenario.ts';
import type { Forge, Issue, Pull, Repo } from './store.ts';

export interface RestRequest {
  method: string;
  segments: string[]; // path segments after /api/v3, already decoded
  query: URLSearchParams;
  body: unknown; // parsed JSON, or undefined when there is no body
  baseUrl: string;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResponse => ({ status, body, headers });
const notFound = (message = 'Not Found'): RestResponse => json(404, { message });
const badRequest = (message: string): RestResponse => json(400, { message });
const unprocessable = (message: string): RestResponse => json(422, { message });

function asObject(body: unknown): Record<string, unknown> | null {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: forge.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    fork: false,
  };
}

function commitJson(forge: Forge, repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha,
    node_id: `C_${sha.slice(0, 12)}`,
    commit: {
      // The stored object ends the message with a newline; the REST view
      // drops that one trailing newline, as GitHub does.
      message: commit.message.replace(/\n$/, ''),
      author: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
      committer: { name: VIEWER.name, email: VIEWER.email, date: trialNowIso() },
    },
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: forge.globalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: issue.comments.length,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: forge.globalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: forge.mergeable(repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

/** Paginate a list; returns the page plus a Link header when more pages exist. */
function paginate<T>(items: readonly T[], query: URLSearchParams, baseUrl: string, path: string): { page: T[]; link: string | null } {
  const perPageRaw = parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const next = new URLSearchParams(query);
    next.set('page', String(p));
    next.set('per_page', String(perPage));
    return `${baseUrl}${path}?${next.toString()}`;
  };
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  }
  return { page: [...slice], link: links.length > 0 ? links.join(', ') : null };
}

function withLink(response: RestResponse, link: string | null): RestResponse {
  if (link === null) return response;
  return { ...response, headers: { ...(response.headers ?? {}), Link: link } };
}

export function handleRest(forge: Forge, request: RestRequest): RestResponse | null {
  const { method, segments, query } = request;
  const path = `/api/v3/${segments.join('/')}`;

  // Root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return json(404, { message: 'Not Found' });
    return json(200, {
      current_user_url: `${request.baseUrl}/api/v3/user`,
      repository_url: `${request.baseUrl}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${request.baseUrl}/api/v3/user/repos`,
    }, { 'X-Oauth-Scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return notFound();
    return json(200, { installed_version: '1.0.0' });
  }
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return notFound();
    return json(200, { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email });
  }

  // POST /user/repos and GET /user/repos.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const body = asObject(request.body);
      if (body === null) return badRequest('request body must be a JSON object');
      const name = asString(body.name);
      if (name === undefined || name === '') return unprocessable('name is required');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return unprocessable(`invalid repository name ${JSON.stringify(name)}`);
      const repo = forge.createRepo(name, {
        private: asBoolean(body.private) ?? false,
        description: asString(body.description) ?? '',
      });
      if (repo === null) return unprocessable(`Repository ${VIEWER.login}/${name} already exists`);
      return json(201, repoJson(forge, repo));
    }
    if (method === 'GET') {
      const repos = forge.listRepos();
      const { page, link } = paginate(repos.map((repo) => repoJson(forge, repo)), query, request.baseUrl, path);
      return withLink(json(200, page), link);
    }
    return notFound();
  }

  // /repos/{owner}/{repo}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = forge.getRepo(owner, name);
    if (repo === undefined) return notFound();
    const rest = segments.slice(3);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(forge, repo));
      if (method === 'PATCH') {
        const body = asObject(request.body);
        if (body === null) return badRequest('request body must be a JSON object');
        const description = asString(body.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = asBoolean(body.private);
        if (isPrivate !== undefined) repo.private = isPrivate;
        return json(200, repoJson(forge, repo));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return notFound();
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = asObject(request.body);
        if (body === null) return badRequest('request body must be a JSON object');
        const ref = asString(body.ref);
        const sha = asString(body.sha);
        if (ref === undefined || !ref.startsWith('refs/')) return unprocessable('ref must start with refs/');
        if (sha === undefined || repo.objects.get(sha)?.type !== 'commit') return unprocessable('sha does not name a commit');
        if (repo.refs.has(ref)) return unprocessable('Reference already exists');
        repo.refs.set(ref, sha);
        return json(201, { ref, node_id: `R_${sha.slice(0, 12)}`, object: { sha, type: 'commit' } });
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = rest.join('/');
        const sha = repo.refs.get(ref);
        if (sha === undefined) return notFound();
        return json(200, { ref, node_id: `R_${sha.slice(0, 12)}`, object: { sha, type: 'commit' } });
      }
      return notFound();
    }

    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const branches = [...repo.refs.entries()]
          .filter(([name]) => name.startsWith('refs/heads/'))
          .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha } }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return json(200, branches);
      }
      if (method === 'GET' && rest.length === 2) {
        const branch = rest[1] as string;
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return notFound();
        return json(200, { name: branch, commit: { sha }, protected: false });
      }
      return notFound();
    }

    // commits
    if (rest[0] === 'commits') {
      if (method === 'GET' && rest.length === 1) {
        const shaParam = query.get('sha');
        const tip = shaParam !== null ? forge.resolveRef(repo, shaParam) : forge.defaultTip(repo);
        if (tip === undefined) return json(200, []);
        const commits = forge.commitsFrom(repo, tip)
          .map((sha) => commitJson(forge, repo, sha))
          .filter((item): item is Record<string, unknown> => item !== null);
        const { page, link } = paginate(commits, query, request.baseUrl, path);
        return withLink(json(200, page), link);
      }
      return notFound();
    }

    // contents
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      if (method === 'GET') {
        const ref = query.get('ref') ?? undefined;
        const result = forge.getContent(repo, contentPath, ref);
        if (result.status === 404) return notFound(result.message);
        return json(200, result.entry);
      }
      if (method === 'PUT') {
        const body = asObject(request.body);
        if (body === null) return badRequest('request body must be a JSON object');
        const content = asString(body.content);
        const message = asString(body.message) ?? `Update ${contentPath}`;
        if (content === undefined) return badRequest('content is required');
        const branch = asString(body.branch);
        const sha = asString(body.sha);
        const result = forge.putContent(repo, {
          path: contentPath,
          content: Buffer.from(content, 'base64'),
          message,
          branch,
          sha,
        });
        if (result.status === 404) return notFound(result.message);
        if (result.status === 409) return json(409, { message: result.message });
        const entry = forge.getContent(repo, contentPath, branch);
        const file = entry.status === 200 && !Array.isArray(entry.entry) ? entry.entry : null;
        return json(result.status, {
          content: file,
          commit: { sha: result.commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const body = asObject(request.body);
        if (body === null) return badRequest('request body must be a JSON object');
        const message = asString(body.message) ?? `Delete ${contentPath}`;
        const branch = asString(body.branch);
        const sha = asString(body.sha);
        const result = forge.deleteContent(repo, { path: contentPath, message, branch, sha });
        if (result.status === 404) return notFound(result.message);
        if (result.status === 409) return json(409, { message: result.message });
        return json(200, { commit: { sha: result.commitSha, message } });
      }
      return notFound();
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const body = asObject(request.body);
        if (body === null) return badRequest('request body must be a JSON object');
        const name = asString(body.name);
        if (name === undefined || name === '') return unprocessable('name is required');
        const label = forge.createLabel(repo, name, asString(body.color));
        return json(201, { name: label.name, color: label.color });
      }
      return notFound();
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = asObject(request.body);
          if (body === null) return badRequest('request body must be a JSON object');
          const title = asString(body.title);
          if (title === undefined || title === '') return unprocessable('title is required');
          const labels = Array.isArray(body.labels)
            ? (body.labels as unknown[]).map((label) => (typeof label === 'string' ? label : (label as { name?: string }).name)).filter((label): label is string => label !== undefined)
            : [];
          const result = forge.createIssue(repo, { title, body: asString(body.body), labels });
          if ('status' in result) return unprocessable(result.message);
          return json(201, issueJson(forge, repo, result));
        }
        if (method === 'GET') {
          const issues = forge.listIssues(repo, {
            state: query.get('state') ?? undefined,
            sort: query.get('sort') ?? undefined,
            direction: query.get('direction') ?? undefined,
          });
          const { page, link } = paginate(issues.map((issue) => issueJson(forge, repo, issue)), query, request.baseUrl, path);
          return withLink(json(200, page), link);
        }
        return notFound();
      }
      const number = parseInt(rest[1] as string, 10);
      if (!Number.isFinite(number)) return notFound();
      if (rest.length === 2) {
        const issue = forge.getIssue(repo, number);
        if (issue === undefined) return notFound();
        if (method === 'GET') return json(200, issueJson(forge, repo, issue));
        if (method === 'PATCH') {
          const body = asObject(request.body);
          if (body === null) return badRequest('request body must be a JSON object');
          const state = asString(body.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = asString(body.title);
          if (title !== undefined) issue.title = title;
          const bodyText = asString(body.body);
          if (bodyText !== undefined) issue.body = bodyText;
          return json(200, issueJson(forge, repo, issue));
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const issue = forge.getIssue(repo, number);
        if (issue === undefined) return notFound();
        if (method === 'GET') {
          return json(200, issue.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: VIEWER.login, id: VIEWER.id },
            created_at: trialNowIso(),
            updated_at: trialNowIso(),
          })));
        }
        if (method === 'POST') {
          const body = asObject(request.body);
          if (body === null) return badRequest('request body must be a JSON object');
          const text = asString(body.body);
          if (text === undefined) return unprocessable('body is required');
          const comment = forge.createComment(repo, number, text);
          if (comment === undefined) return notFound();
          return json(201, {
            id: comment.id,
            body: comment.body,
            user: { login: VIEWER.login, id: VIEWER.id },
            created_at: trialNowIso(),
            updated_at: trialNowIso(),
          });
        }
        return notFound();
      }
      return notFound();
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = asObject(request.body);
          if (body === null) return badRequest('request body must be a JSON object');
          const head = asString(body.head);
          const base = asString(body.base);
          const title = asString(body.title);
          if (head === undefined || base === undefined) return unprocessable('head and base are required');
          if (title === undefined || title === '') return unprocessable('title is required');
          const result = forge.createPull(repo, { head, base, title, body: asString(body.body) });
          if ('status' in result) {
            return result.status === 404 ? notFound(result.message) : unprocessable(result.message);
          }
          return json(201, pullJson(forge, repo, result));
        }
        if (method === 'GET') {
          const pulls = forge.listPulls(repo, { state: query.get('state') ?? undefined });
          const { page, link } = paginate(pulls.map((pull) => pullJson(forge, repo, pull)), query, request.baseUrl, path);
          return withLink(json(200, page), link);
        }
        return notFound();
      }
      const number = parseInt(rest[1] as string, 10);
      if (!Number.isFinite(number)) return notFound();
      if (rest.length === 2) {
        const pull = forge.getPull(repo, number);
        if (pull === undefined) return notFound();
        if (method === 'GET') return json(200, pullJson(forge, repo, pull));
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'files') {
        const pull = forge.getPull(repo, number);
        if (pull === undefined) return notFound();
        if (method === 'GET') return json(200, forge.pullFiles(repo, pull));
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method === 'PUT') {
          const body = asObject(request.body) ?? {};
          const method = asString(body.merge_method) ?? 'squash';
          const result = forge.mergePull(repo, number, method);
          if (result.status === 404) return notFound(result.message);
          if (result.status === 405) return json(405, { message: result.message });
          return json(200, { sha: result.sha, merged: true, message: result.message });
        }
        return notFound();
      }
      return notFound();
    }

    return notFound();
  }

  return null;
}
