// The HTTP server: one in-memory Forge behind four surfaces.
//   POST /mcp              MCP (Streamable HTTP, JSON-RPC 2.0)
//   POST /api/graphql      GraphQL
//   /api/v3/*              GitHub REST API v3
//   /{owner}/{repo}.git/*  git smart HTTP
//
// Every request except GET /healthz needs `Authorization: Bearer
// <MAKEFUN_SHOP_TOKEN>` (a wrong or missing token is a 401 on every
// surface). Every reply carries `X-GitHub-Request-Id: req-N` (a
// deterministic counter). REST replies are always application/json and
// never HTML. Unknown routes are 404 {message}; malformed JSON bodies
// are 400 {message}.
//
// createApp() returns the bare Server, as main.ts expects: main.ts binds
// the ephemeral port, registers it with the env and polls /done.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { handleGitRequest } from './src/git.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { SHOP_TOKEN } from './src/scenario.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const forge = new Forge();
  let requestCounter = 0;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      requestCounter += 1;
      const requestId = `req-${requestCounter}`;
      response.setHeader('X-GitHub-Request-Id', requestId);
      const sendJson = (status: number, body: unknown, extraHeaders?: Record<string, string>): void => {
        if (extraHeaders !== undefined) {
          for (const [key, value] of Object.entries(extraHeaders)) response.setHeader(key, value);
        }
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(body === null ? '' : JSON.stringify(body));
      };
      const sendBuffer = (status: number, contentType: string, body: Buffer): void => {
        response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
        response.end(body);
      };
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const path = url.pathname;

        // The env's boot check: 200 {"ok":true}, no auth.
        if (request.method === 'GET' && path === '/healthz') {
          sendJson(200, { ok: true });
          return;
        }

        // Auth: every other surface, including the git endpoints.
        const authorization = request.headers.authorization ?? '';
        const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
        if (token !== SHOP_TOKEN) {
          sendJson(401, { message: 'Bad credentials' });
          return;
        }
        const body = request.method === 'GET' || request.method === 'HEAD' ? Buffer.alloc(0) : await readBody(request);

        if (path === '/mcp' && request.method === 'POST') {
          const result = handleMcp(forge, body);
          if (result.body === null) {
            response.writeHead(result.status);
            response.end();
            return;
          }
          sendBuffer(result.status, 'application/json', result.body);
          return;
        }

        if (path === '/api/graphql' && request.method === 'POST') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8')) as unknown;
          } catch {
            sendJson(400, { message: 'request body is not valid JSON' });
            return;
          }
          const result = handleGraphQL(forge, parsed);
          sendJson(result.status, result.body);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          const segments = restPath === '' ? [] : restPath.split('/').map((segment) => {
            try {
              return decodeURIComponent(segment);
            } catch {
              return segment;
            }
          });
          let parsedBody: unknown;
          if (body.length > 0) {
            try {
              parsedBody = JSON.parse(body.toString('utf8')) as unknown;
            } catch {
              sendJson(400, { message: 'request body is not valid JSON' });
              return;
            }
          }
          const baseUrl = `http://127.0.0.1:${(server.address() as { port: number } | null)?.port ?? 0}`;
          const result = handleRest(forge, {
            method: request.method ?? 'GET',
            segments,
            query: url.searchParams,
            body: parsedBody,
            baseUrl,
          });
          if (result === null) {
            sendJson(404, { message: 'Not Found' }, { 'X-Oauth-Scopes': 'repo, read:org' });
            return;
          }
          if (result.status === 204) {
            response.writeHead(204);
            response.end();
            return;
          }
          sendJson(result.status, result.body, { 'X-Oauth-Scopes': 'repo, read:org', ...(result.headers ?? {}) });
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          const owner = gitMatch[1] as string;
          const repoName = gitMatch[2] as string;
          const subpath = gitMatch[3] ?? '';
          const repo = forge.getRepo(owner, repoName);
          if (repo === undefined) {
            sendJson(404, { message: 'Not Found' });
            return;
          }
          const gitProtocol = request.headers['git-protocol'];
          const version2 = typeof gitProtocol === 'string' && gitProtocol.includes('version=2');
          const result = handleGitRequest(forge, repo, {
            method: request.method ?? 'GET',
            subpath,
            query: url.searchParams,
            gitProtocolVersion2: version2,
            body,
          });
          if (result === null) {
            sendJson(404, { message: 'Not Found' });
            return;
          }
          sendBuffer(result.status, result.contentType, result.body);
          return;
        }

        sendJson(404, { message: 'Not Found' });
      } catch (err) {
        // Never let one bad request kill the server.
        if (!response.writableEnded) {
          try {
            sendJson(500, { message: (err as Error).message });
          } catch {
            // The socket is already gone; nothing more to do.
          }
        }
      }
    })();
  });

  return server;
}
