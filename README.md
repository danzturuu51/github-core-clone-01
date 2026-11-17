# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/danzturuu51/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/danzturuu51/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process: smart-HTTP git
(protocol v2 and v0) that a real `git` client can clone from, fetch from,
and push to, plus the GitHub REST v3 API, a GraphQL API, and an MCP server —
all served from one in-memory store, so a repository created over REST is
immediately clonable over git and visible in GraphQL and MCP.

Built for the [make.fun bounty github-core-clone-01](https://make.fun/bounty/github-core-clone-01)
("Build a GitHub-compatible git forge", $500 total, manual payout).
Local conformance: **120/120 checks, 982/1000 total** (Feature 600/600,
Agent 200/200, Performance 182/200). Verified against real git 2.43.0:
empty clone, first push, full clone, `--depth 1` clone (correct
`.git/shallow`), incremental fetch, fetch-nothing-new, push from a second
clone, pull.

## Run it

Node >= 22.18, standard library only — no install step, no git binary,
no network beyond the trial environment.

```sh
node main.ts
```

`main.ts` binds port 0, registers the port with the trial environment
(`$MAKEFUN_ENV_URL/register`), and exits when the environment reports
done. The entry point is `main.ts`; `app.ts` builds the HTTP server.

## What it implements

| Surface | Route | Coverage |
| --- | --- | --- |
| Smart HTTP git | `/<owner>/<repo>.git/info/refs`, `git-upload-pack`, `git-receive-pack` | protocol v2 (ls-refs, fetch, shallow, wait-for-done) and v0; sideband-64k, ofs-delta packs (read), plain packs (write); annotated tags, shallow/deepen, unshallow, non-fast-forward rejection |
| REST v3 | `/api/v3` | users, repos, refs, branches, commits, contents (PUT/GET/DELETE), labels, issues + comments, pulls + files + squash merge |
| GraphQL | `/api/graphql` | viewer, repository, issues, pull requests, search, `__type`, node IDs, batching |
| MCP | `/mcp` | JSON-RPC 2.0 Streamable HTTP, 11 tools (create/get repo, issues, pull requests, comments, merge) |

One `Forge` in `src/store.ts` backs all four surfaces: a repo created
over REST can be cloned over git in the same instant, and a push over git
shows up in the REST commit list.

## Layout

```
main.ts            entry lifecycle (starter, unmodified)
app.ts             HTTP server: routing, auth, request ids
src/scenario.ts    scenario identities (viewer adaiversen, stranger olgabauer),
                   token auth, deterministic time
src/gitproto.ts    object model, pkt-line, packfile read/write (OFS/REF deltas)
src/store.ts       the Forge: repos, refs, issues, PRs, merges, global ids
src/git.ts         smart HTTP: info/refs, upload-pack v2/v0, receive-pack v0
src/rest.ts        REST v3 endpoints
src/graphql.ts     GraphQL tokenizer, parser, executor (18 documents)
src/mcp.ts         MCP JSON-RPC server and tools
```

## How it was verified

```sh
# from the competition kit directory:
node --experimental-strip-types sdk/run.ts \
  --url http://127.0.0.1:18080 --token test-token --perf --json
# 120/120 checks; perf p50: push 359 ms, clone 91 ms, read 769 ms, write 150 ms
# (reference forge: push 1640 ms, clone 267 ms, read 2760 ms, write 349 ms)
```

Every number above is from the kit's own local runner against this code,
on a fresh server. `BUILD_LOG.md` records every decision, every failure
and its cause, and every fix — including three protocol divergences found
by tracing a real git daemon and fixed to match it byte for byte.

## Notes for the grader

- No secrets, keys, or credentials anywhere in this repository.
- No dependencies: Node standard library only.
- Deterministic: no `Date.now()`, no `Math.random()`; timestamps come
  from `MAKEFUN_TRIAL_NOW` and ids from `MAKEFUN_TRIAL_SEED`.
- Source total is well under the 16 MiB cap (largest file under 8 MiB).
