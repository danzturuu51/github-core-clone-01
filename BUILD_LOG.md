# BUILD_LOG — github-core-clone-01

A GitHub-compatible git forge for the make.fun bounty
**github-core-clone-01** ("Build a GitHub-compatible git forge").
Prize $500 total, payout MANUAL (not escrowed): 1st $100, 2nd $70, 3rd $50,
4th–10th $20, 11th–20th $14. No entry fee. Deadline 21 Nov 2026 13:30 WIB.
Target: rank 1. Prize goes to Putra's motor fund (Yamaha MX King second).

Build started 17 Nov 2026 ~12:50 WIB by a builder subagent. This log records
every decision, what was tried, what failed and why, and what was fixed —
so the next build is better.

## 0. Ground rules for this session

- Do NOT submit, do NOT create any GitHub repo, do NOT touch the
  token-radar-01 repo. The parent handles repo + upload + submit +
  transcripts. This session delivers a verified local repo only.
- No secret, API key, wallet key, or credential anywhere in the repo.
- Free only: no capital, no purchases, no paid services.
- Commit locally with git as the build proceeds.

## 1. The kit, read in full

Kit: `~/workspace/makefun/github-core-clone-01-kit/`. Read in full before
writing any code: `RULES.txt` (395 lines), `competition.yaml` (457 lines),
`kit.json`, `cli/makefun.mjs`, `program/` (env, generator, scorer),
`sdk/` (conformance, makefun-agent.ts), `practice/` (trial-0/1/2),
`gateway/`, `rules/instance.yaml`, `starter/` (main.ts, app.ts,
package.json, tsconfig.json, LICENSE, README.md).

Key facts extracted from the kit:

- The entry runs as `node /bot/main.ts` (Node >= 22.18, type stripping
  built in), stdlib only, no install, no git binary, no network besides
  the trial env. The repo is read-only at `/bot`; writes only in `/tmp`.
  Trial limits: 2 CPU, 1024 MB, 256 processes, 900 s wall budget.
- Size caps: **max 16 MiB source total, 8 MiB per file.**
- Repo must be public, OSI licence, created after the competition opened
  (2026-11-14T06:30:00Z). README needs the 3 live make.fun badges +
  a link to a make.fun page, no `{owner}` placeholders. GitHub About:
  website on make.fun + topic `makefun`. Owner `≠` account login needs
  `.makefun/owner.json` `{"wallet": "<address>"}`.
- Lifecycle (`main.ts` starter, DO NOT modify): bind port 0 → POST
  `$MAKEFUN_ENV_URL/register` `{"port": N}` → poll GET `/done` until
  `{"done": true}` → exit 0. Never bind 8080. `main.ts` calls
  `createApp()` and expects a **Server directly** (not an object
  `{server, forge}`).
- Scoring: Feature 600 (round(600 × passed/120)), Agent/MCP 200,
  Performance 200. Total 0–1000. The reference forge (house baseline)
  passes **120/120** — so to win a prize the entry must pass 120/120
  AND beat the baseline on perf with significance (90% t-interval lead
  per instance > 0). Calibrated T_ref (median of 3 baseline runs in
  production): push 1640.82 ms, clone 266.941 ms, read 2759.715 ms,
  write 348.965 ms.
- Determinism / replay: finalists are replayed — replay must produce a
  byte-identical state export. Forbidden: `Date.now()` / `new Date()`,
  `Math.random()` / random UUIDs (use `MAKEFUN_TRIAL_NOW` /
  `MAKEFUN_TRIAL_SEED` from the SDK), a single request order to the env.
- Practice trials: 3 instances from drand round 33447412 (2026-10-28).
  Final: 3 instances from the first round ≥ final phase
  (2026-11-21T06:40:00Z), 10 minutes after the deadline. Top 60 (+ ties)
  reach the final 3 instances; the baseline always passes the final and
  takes no seat.
- Transcript gate (9 checks): transcripts present/recorded, thinking
  well-formed ≤ 60 s, in-window ±60 s, reproduces ≥ 30%, turns ≥ 5,
  priced 100% + min 1 muse-app-usage row, revised ≥ 2 messages, fresh
  100% for the source bundle, run_record required since 17 Nov 2026.
  Transcripts are the parent's job, not this session's.

### What "GitHub-compatible" means for the grader (120 checks)

- **git (30 checks):** protocol v2 advertisement + capabilities,
  receive-pack v0 advertisement, info/refs headers, ls-refs with
  ref-prefix filtering, clone of an empty repo, clone with an annotated
  tag (tag object must ship, peeled), push of a new branch, push of a
  tag, non-fast-forward rejection, fetch with haves (ACK/NAK),
  fetch-nothing-new (0 objects), shallow fetch depth 1, deepen, clone
  with `--depth 1`, sideband framing, packfile checksums, OFS/REF delta
  reading, commit graph traversal, branch listing.
- **repos (15):** create/list/get/patch/delete repos, branches, commits
  list (?sha=), contents PUT/GET/DELETE (201 vs 200, 409 on stale sha),
  labels.
- **issues (15):** create/list/get/close, comments, pagination, state
  transitions, global ids.
- **pulls (20):** create/list/get, files (multiset line diff), merge
  (squash), mergeable/conflict, close.
- **protocol (5):** auth (401 without token, on every surface), request
  ids, content types, unknown routes, malformed JSON.
- **graphql (20):** 18 documents (viewer, repository, issues, PRs,
  search, `__type`, node), unknown-field errors (`noSuchFieldOn<Type>`),
  batching, state enums (OPEN/CLOSED/MERGED).
- **mcp (15):** discover/initialize/ping, tools/list byte-identical,
  11 tools, unknown tool -32602, malformed JSON 400 -32700, missing
  required args → isError.

## 2. Architecture

One in-memory `Forge` (`src/store.ts`) backs all four surfaces, so a repo
created over REST is immediately clonable over git and visible in GraphQL
and MCP. No persistence: the trial is a single process; state lives for
the life of the trial.

```
main.ts            entry lifecycle (starter, copied verbatim, unmodified)
app.ts             HTTP server: routing, auth, request ids, body limits
src/scenario.ts    scenario identities, token auth, deterministic time
src/gitproto.ts    object model, pkt-line, packfile read/write
src/store.ts       the Forge: repos, refs, issues, PRs, merges, global ids
src/git.ts         smart HTTP: info/refs, upload-pack v2/v0, receive-pack v0
src/rest.ts        REST v3 endpoints
src/graphql.ts     GraphQL tokenizer, parser, executor (18 documents)
src/mcp.ts         MCP JSON-RPC server and tools
```

Design decisions and why:

- **In-memory, single Forge.** The grader's checks create a repo on one
  surface and read it on another (e.g. push over git, then list commits
  over REST). A single store is the only way to keep the four surfaces
  consistent without a database.
- **Plain packs on write, delta packs on read.** The server writes packs
  with plain objects only (no delta encoding) — simpler, deterministic,
  and fast enough to beat the reference. It READS OFS_DELTA and REF_DELTA
  packs (real git clients send delta packs on push), applying deltas in
  `applyDelta` in gitproto.ts.
- **No git binary.** Everything (SHA-1, zlib, packfile, pkt-line) is
  implemented in TypeScript on the Node stdlib, because the trial has no
  git binary and no install step.
- **TypeScript with erasable syntax only.** Node 22/24 type stripping
  supports a subset of TS: no enums, no parameter properties, no
  namespaces. The grader runs Node 22; the dev VM runs Node 24.22.1.
  All code must type-strip cleanly on both.

## 3. Scenario identities — the Rng port (a real bug caught early)

The scenario is built once from the constant
`SCENARIO_SEED = 0x6a09e667f3bcc909n`; live, replay, and local practice see
byte-identical data. The entry receives NO login from anywhere — only a
bearer token — so the viewer login must be derived from the generator seed
(port of `Rng` + `generateUsers` from the kit's wire.ts).

**First attempt was wrong.** My first port used an LCG plus a wrong
`mix64` and produced the wrong identities. The correct port, verified
against the kit's `buildScenario()`:

- `mix64` is the splitmix64 finalizer with the golden-gamma add:
  `z = (value + 0x9e3779b97f4a7c15n)`, multiply by
  `0xbf58476d1ce4e5b9n` then `0x94d049bb133111ebn`, shifts 30/27/31.
- `Rng` is **xorshift64\***:
  `x ^= x >> 12; x ^= x << 25; x ^= x >> 27; return x * 0x2545f4914f6cdd1dn`.
- `nextU32()` is the top half of `nextU64`; `nextInt` uses rejection
  sampling (limit = 2^32 − (2^32 % max), repeat while value ≥ limit).
- `SCENARIO_USERS = 12`; `generateUsers` uses base `${first}${last}` +
  sanitisation `[^a-z0-9-]` + suffix `-2`, etc.

Verification: the port produces viewer **`adaiversen`** (id 1000, name
"ada iversen", email adaiversen@example.invalid), teammate `quinnkeller`,
stranger **`olgabauer`**, org `faint-meadow-org`, first repo `amber-thistle`.
All match the kit's `buildScenario()` output.

## 4. Auth and deterministic time

- Token: `MAKEFUN_SHOP_TOKEN` from the environment. The entry matches
  the `Authorization: Bearer <token>` header against it on every surface
  (REST, GraphQL, MCP, git). Wrong or missing token → 401 on all
  surfaces. If the env var is unset (local dev only), it falls back to
  the dev token `'local-dev-token'` so auth is still enforced and the
  unauthenticated checks fail the same way. This fallback cannot trigger
  in a trial (the env var is always set there).
- Time: `MAKEFUN_TRIAL_NOW` (ms) → seconds, used for generated commit
  timestamps (contents, merge) and `merged_at`. Fallback constant
  1700000000. `Date.now()` / `new Date()` appear nowhere in the entry.

## 5. Module notes (what each file does, and the traps inside it)

### src/gitproto.ts — object model + pkt-line + packfile

- SHA-1 (Node `crypto`), zlib (Node `zlib`), pack write with plain
  objects only, pack read resolving OFS_DELTA / REF_DELTA (`applyDelta`).
- Tree / commit / tag parse and build, `collectReachable` (BFS from wants
  through commits → trees → blobs, peeling tags), `treeLookup`,
  `flattenTree`, `buildTreeFromFilesWithStore`.
- Trap: a pack's objects must be written in an order where a delta's base
  precedes the delta. Plain packs avoid the issue entirely.

### src/store.ts — the Forge

- `Repo`: objects `Map<oid, GitObject>`, refs `Map<ref, oid>`, labels,
  `numbered[]` — **issues and PRs share ONE counter** (GitHub behaviour:
  issue #1 then PR #2, etc.), `nextNumber`, `nextCommentId`,
  `databaseId`.
- Contents: PUT 201 (new file) / 200 (update), 409 on stale sha, DELETE.
- Branches, commits (pre-order DFS), `isAncestor`, `mergeBase` (BFS
  from both tips), three-way file merge (conflict → 405), squash merge,
  `pullFiles` (multiset line diff: added/removed lines counted with
  multiplicity, so duplicate lines are handled).
- Global ids are opaque and prefixed: `R<dbid>` (repo), `I<dbid>_<n>`
  (issue), `P<dbid>_<n>` (PR), `C<dbid>_<n>_<cid>` (comment), with
  `decodeGlobalId` to reverse them.

**Trap — TypeScript union narrowing.** A return type like
`{status: 404 | 409}` cannot be narrowed by checking `result.status`
because the discriminant is itself a union. The fix: split into
single-literal members (`{status: 404} | {status: 409}`) in the return
types of `putContent`, `deleteContent`, `mergePull`.

### src/git.ts — smart HTTP

- `info/refs`: v2 advertisement when the request carries
  `Git-Protocol: version=2`, else v0; receive-pack gets a v0 ref
  advertisement with push capabilities.
- ls-refs v2: HEAD with `symref-target`, peeled tags
  (`<oid> <name> peeled:<commit>`), ref-prefix filtering server-side.
- fetch v2: sections `acknowledgments` / `shallow-info` / `packfile`,
  sideband band 1. fetch v0: NAK/ACK lines, shallow lines, sideband pack.
- receive-pack v0: `report-status` in sideband band 1, `unpack ok`,
  per-ref `ok` / `ng`, non-fast-forward → `ng <ref> non-fast-forward`.
  A mixed push applies the fast-forward refs and rejects the rest.
- Packs are always plain objects.
- Fetch planning (`planFetch`): BFS depth limit, haves closure (a shallow
  boundary contributes only itself, not its ancestors), new shallow =
  commits at the depth boundary, unshallow = old boundaries whose parents
  are now sent/held.

**Trap — `fetchV2` section rules (found by tracing a real git daemon,
see §8).** The `acknowledgments` section exists ONLY when the client
sent haves; the `packfile` section is ALWAYS sent, even when it carries
an empty pack. Getting either wrong kills a real `git clone`.

### src/rest.ts — REST v3 under /api/v3

- Root + `X-Oauth-Scopes: repo, read:org`, `/meta`
  `{installed_version}`, `/user`, POST/GET `/user/repos` (Link
  pagination), GET/PATCH/DELETE `/repos`, git/refs, branches, commits
  (`?sha=`), contents (PUT/GET/DELETE), labels, issues (+ comments),
  pulls (+ files, merge squash).
- A repo under another owner → 404 (not 403). Issue/PR REST state is
  lowercase `open`/`closed`.

**Trap — trailing newline.** The stored commit object ends with `\n`,
but the REST `commit.message` view must strip exactly one trailing `\n`.
Run 1 failed `repos.commits` on this (see §7).

### src/graphql.ts — GraphQL executor

- Hand-written tokenizer + recursive-descent parser: variables, enums,
  inline input objects, lists, null, operation names, aliases, inline
  and named fragments. No dependency.
- 18 documents: ViewerLogin, RepositoryFields, Issue_fields,
  PullRequestAndRepositoryFields, SearchType_enumValues, OpenIssues,
  IssueByNumber, IssueCreate, IssueClose, PullRequests, PullRequestFiles,
  PullRequestId, PullRequestCreate, MergePullRequest, AddComment,
  ViewerInvalidField, NodeRepository, IssuesPage. Array batching.
- GraphQL state is UPPERCASE (OPEN/CLOSED/MERGED). Cursor is base64
  `cursor:<index>`. Issues are CREATED_AT DESC = number descending.
- Unknown field → HTTP 200 + `errors` containing `noSuchFieldOn<Type>`
  (e.g. `noSuchFieldOnViewer`). `__type` fields/enumValues; SearchType
  must be ISSUE.

**Trap — `mergeable` is an enum, not a boolean.** Run 1 failed
`graphql.pull-requests-list` because it returned `mergeable: true`.
GraphQL `mergeable` is `MERGEABLE` / `CONFLICTING` (see §7).

**Trap — parameter properties.** Node type-stripping does not support
`constructor(private readonly tokens)` — it failed strip-types. Fixed
to a plain field + assignment.

### src/mcp.ts — MCP over Streamable HTTP

- POST `/mcp`, JSON-RPC 2.0, plain JSON (not SSE): `server/discover`
  (2026-07-28: supportedVersions `['2026-07-28','2025-06-18',
  '2025-03-26']`, capabilities `{tools:{}}`, serverInfo
  `{name 'makefun-forge', version '1.0.0'}`, `_meta`
  `io.modelcontextprotocol/serverInfo`) + legacy `initialize` fallback +
  `notifications/initialized` (202, no reply) + `ping`.
- 11 tools (6 required: create_repo, get_repo, create_issue,
  list_issues, create_pull_request, merge_pull_request; plus list_repos,
  get_issue, create_comment, close_issue, list_pull_requests).
- `tools/list` is byte-identical across calls. Unknown tool → -32602.
  Non-JSON body → HTTP 400 -32700. Missing required argument →
  `isError: true`. Results carry both `structuredContent` and a `text`
  JSON string of the same value (create_repo includes `full_name`;
  create_issue / create_pull_request include `number`). Required schemas
  contain only what the suite can fill (create_repo requires only `name`).

### app.ts — the HTTP server (root of the repo, NOT src/)

- One Forge behind all four surfaces + GET `/healthz` 200 `{ok:true}`
  **without auth** (the env's boot check).
- Every other route requires `Authorization: Bearer <SHOP_TOKEN>` →
  401 `{message}`. Every reply carries `X-GitHub-Request-Id: req-N`
  (deterministic counter). REST replies are always `application/json`.
  Unknown route → 404 `{message}`. Malformed JSON → 400 `{message}`.
  Body max 64 MiB. One bad request must never kill the server.

**Trap — `app.ts` location.** `main.ts` (starter) imports `./app.ts`,
so `app.ts` must live at the repo ROOT, not in `src/`. It was first
written into `src/` by mistake and moved to the root on 17 Nov ~13:58.

**Trap — `createApp()` return type.** `main.ts` calls `.listen(0)` and
`.address()` on the result, so `createApp()` must return a `Server`
directly — not an object `{server, forge}`. Fixed during the build.

## 6. Typecheck setup

TypeScript 5.9 + @types/node installed in `/tmp/tscheck` (outside the
repo, so the entry stays clean). Command:

```sh
npx --prefix /tmp/tscheck tsc --noEmit -p tsconfig.json \
  --typeRoots /tmp/tscheck/node_modules/@types
```

Clean, 0 errors (17 Nov ~14:00, and again after the §8 fixes).

## 7. Verification history — kit conformance runs

Dev server launcher: `/tmp/dev-server.mjs`
(`MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types
/tmp/dev-server.mjs`), port 18080. Runner:
`node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18080
--token test-token [--perf] [--json]` from the kit directory.

### Run 1 — 17 Nov ~14:00 — 117/120

Three failures, all real bugs in the entry:

1. `git.clone-annotated-tag` — the tag object itself was not shipped.
   Cause: `planFetch` peeled the tag want to its commit before
   collecting objects, so the tag object never entered the pack.
   Fix: collect the reachable closure from the RAW wants (the tag
   object ships, and `collectReachable` peels it for the commit
   closure); only the BFS depth-limit path peels wants to commits.
2. `repos.commits` — REST `commit.message` carried a trailing `\n`.
   Cause: the stored commit object ends with `\n` and the view passed
   it through. Fix: strip exactly one trailing `\n` in the REST view.
3. `graphql.pull-requests-list` — `mergeable` was returned as a boolean.
   Cause: assumed boolean. Fix: GraphQL `mergeable` is the enum
   `MERGEABLE` / `CONFLICTING`.

### Run 2 — 17 Nov ~14:05, fresh server — 120/120

Feature 600/600, Agent 200/200, score 800 (no perf). All three fixes
verified.

### Run 3 — 17 Nov ~14:08, `--perf` on the SAME server as run 2 — 35/120

**Not an entry bug: state contamination.** The server is in-memory and
still held run 2's repos, which have the same deterministic names
("already exists", PRs already present, pages repo already at 14
issues). Lesson: **every conformance run needs a fresh server.**

### Run 4 — 17 Nov ~14:10, fresh server + `--perf` — 120/120, total 985

Feature 600, Agent 200, Perf 185, perf_p50_us 240208. Per workload
(p50): push 374.116 ms → 50 pts; clone 93.826 ms → 44; read 842.78 ms
→ 46; write 112.54 ms → 45. All far below T_ref (push 1640.82, clone
266.941, read 2759.715, write 348.965 ms).

### Run 5 — 17 Nov ~14:20, fresh server + `--perf` — 120/120, total 982

Feature 600, Agent 200, Perf 182, perf_p50_us 248007. Per workload
(p50): push 359.261 ms → 50 pts; clone 91.26 ms → 44; read 769.277 ms
→ 48; write 149.996 ms → 40. (Write p50 moved 112 → 150 ms between
runs; this is run-to-run noise on a shared VM, not a code change —
no code changed between run 4 and run 5 except the §8 fixes, which do
not touch the write path.)

## 8. Real-git testing — the part the kit cannot check

The kit's git client is a re-implementation; it does not behave exactly
like real git. So the entry was also tested against real git 2.43.0,
with a real `git-upload-pack` daemon as ground truth
(`git daemon --export-all --base-path=/tmp/realgit-test` on port 19418,
bare repo with 3–4 commits). Test area: `/tmp/realgit-test`
(HOME=/tmp/realgit-test, `http.extraHeader Authorization: Bearer
test-token`).

### 8.1 The bug real git found first (17 Nov ~14:13)

Clone of a non-empty repo failed:

```
fatal: expected 'packfile', received 'acknowledgments'
```

Cause: `fetchV2` ALWAYS sent the `acknowledgments` section and only
sent the `packfile` section when there were objects to send. A fresh
clone sends no haves, and real git then expects the `packfile` section
immediately. Fix (in `src/git.ts`, `fetchV2` / `fetchV0`):

1. Send the `acknowledgments` section ONLY when the request carries
   ≥ 1 `have`.
2. ALWAYS send the `packfile` section — with an empty 32-byte pack
   (header + SHA-1 trailer, 0 objects) when nothing is new. The kit's
   fetch-nothing-new check only asserts `objects.size === 0`, so an
   empty pack still passes.
3. `shallow-info` only when depth was requested / there are boundary
   or unshallow lines.

### 8.2 Ground truth from the real daemon (packet traces)

Traced with `GIT_TRACE_PACKET`:

- Fresh clone, no haves: server replies `packfile` directly — no
  `acknowledgments`, no `shallow-info`.
- Incremental fetch with haves: client sends `include-tag`, `want`,
  `have` × N, flush (NO `done` line — the server advertises
  `wait-for-done`). Server replies `acknowledgments`, one `ACK <oid>`
  per have it holds, `ready`, delim, `packfile`, sideband pack.
- Clone `--depth 1`: server replies `shallow-info`, `shallow <tip>`,
  `packfile` — no `acknowledgments`.
- The daemon's v2 advertisement includes
  `fetch=shallow wait-for-done`, `server-option`, `object-info`.
  This entry now advertises `fetch=shallow unborn wait-for-done`
  (matching the daemon's fetch line); `server-option` / `object-info`
  are deliberately NOT advertised — the entry does not implement those
  commands, and advertising them would invite requests it cannot serve.
  The kit client splits the fetch value on spaces and only checks for
  `shallow`, so the extra token is harmless.

### 8.3 ls-refs HEAD rule (second divergence)

The entry used to drop HEAD whenever ANY ref-prefix filter was given.
Real git's clone sends `ref-prefix HEAD` among its prefixes and expects
HEAD back (the daemon's ls-refs reply contains both
`HEAD symref-target:...` and `refs/heads/main`). The correct rule,
matching both real git and the kit's `ls-refs-prefix` check (which uses
single prefixes like `refs/heads/`, `refs/tags/`,
`refs/does-not-exist/`): include a ref iff it matches ANY given prefix;
HEAD is included iff it matches a prefix (e.g. `HEAD`) or no prefix
filter is given at all. Fixed in `lsRefsV2`.

### 8.4 Shallow boundary rule (third divergence)

The entry used to mark a sent commit shallow iff it had a parent that
was neither sent nor held. That is wrong for root commits. Verified
against the daemon:

- `--depth 1` clone of a one-commit repo → `.git/shallow` CONTAINS the
  root commit.
- `--depth 3` clone of the same one-commit repo → NO `.git/shallow`.
- `--depth 3` clone of a 4-commit repo → `.git/shallow` contains the
  deepest sent commit (generation 2, whose parent was not sent).
- `--depth 2` clone of a 4-commit repo → `.git/shallow` contains the
  generation-1 commit.

Correct rule: a sent commit is a shallow boundary exactly when it sits
at the deepest generation the depth limit still sends (`depth − 1`,
shortest distance from a want). That includes a root commit at that
generation and excludes a root commit nearer the tip. Fixed in
`planFetch` (the BFS `generations` map is now hoisted out of the
depth branch and used for the shallow computation).

### 8.5 Real-git workflow, all passing (17 Nov ~14:16, after all fixes)

Against the forge on port 18080 (`realgit-demo3`, repo created over
REST):

1. Clone empty repo → "warning: You appear to have cloned an empty
   repository."
2. Push first commit from real git → `main -> main`.
3. Full clone → both commits, files intact (`f1.txt`, `f2.txt`).
4. Clone `--depth 1` → 1 commit, `.git/shallow` contains the root
   commit (matches the daemon exactly).
5. Incremental fetch + fast-forward merge → new commit arrives.
6. Fetch nothing-new (twice) → exit 0, no error.
7. Push from the second clone → accepted.
8. Pull in the first clone → all 4 commits present.

Also verified earlier (before the §8 fixes): clone empty OK, push
first commit OK — only the non-empty clone was broken.

## 9. Kit check (`node cli/makefun.mjs check --worktree`)

Run 17 Nov ~14:12 (before the §8 fixes; the check does not touch the
git protocol): **6 passed, 1 failed, 14 skipped, 5 checked at
submission.** Passed: `competition_open`, `snapshot`, `license_osi`
(MIT), `entrypoint` (main.ts, node22), `entry_size` (175,313 bytes,
inside the cap), `committed_provider_key` (no API key). Failed:
`transcripts_present` — no transcripts exist yet; that is the parent's
job, not this session's. "At submission": `repo_public`, `repo_owner` /
`.makefun/owner.json`, `repo_created_after_open`, `commit_in_repo`,
`duplicate_snapshot` — all parent's job at submit time.

Note: the check output was at one point flagged by the system as not
passing a prompt-injection screen. No instruction from that output was
followed; transcripts/submit were already the parent's job from the
start.

## 10. Repo state at handoff

- Location: `~/workspace/makefun/github-core-clone-01/`
- Files: `main.ts`, `app.ts`, `README.md`, `BUILD_LOG.md`, `LICENSE`
  (MIT, starter), `package.json`, `tsconfig.json`,
  `src/scenario.ts`, `src/gitproto.ts`, `src/store.ts`, `src/git.ts`,
  `src/rest.ts`, `src/graphql.ts`, `src/mcp.ts`.
- Size: ~175 KB total (cap 16 MiB total / 8 MiB per file); largest
  file `src/graphql.ts` ~50 KB.
- `git init` done; commit history is made at handoff (see §11).
- NOT in the repo: `.makefun/owner.json` (parent adds it at submit),
  any secret/key/credential, any `node_modules`, any transcripts.

## 11. What is still needed before submit (parent's job)

1. **Transcripts** — the 9-check transcript gate (recorded sessions
   since 17 Nov 2026, reproduces ≥ 30%, turns ≥ 5, priced 100%,
   revised ≥ 2 messages, fresh 100% for the source bundle).
2. **GitHub repo** — create public repo `danzturuu51/github-core-clone-01`
   (the README badge URLs already assume this owner/repo; if the repo
   is named differently, update the two `rank.svg` / `reward.svg` URLs
   in README.md before submitting). Set GitHub About: website on
   make.fun + topic `makefun`. Push the local commits.
3. **Submit** — via `makefun.mjs` (unsigned entry: this bounty pays
   MANUAL, not escrow — submit the repo without `--keypair`).
   `.makefun/owner.json` `{"wallet": "<address>"}` if the GitHub owner
   differs from the make.fun account login.
4. Deadline: **21 Nov 2026 13:30 WIB.** Submission quota: 5/day UTC,
   10 total; 1 already used by token-radar-01 on this account.

## 12. Open risks / things to watch

- **Perf is the tiebreaker.** The reference forge passes 120/120 too,
  so the prize is decided by perf with significance (90% t-interval
  lead per instance > 0). This entry's local p50s (push ~359 ms, clone
  ~91 ms, read ~769 ms, write ~150 ms) are all far below T_ref, but
  production hardware differs from this VM and the final instances are
  drawn fresh — re-run the kit's `--perf` on the final commit before
  submitting, and do not change code after that run without re-running.
- **Write p50 is noisy** (112 ms in run 4, 150 ms in run 5, same code
  path). If a final perf run dips, the write workload is the one to
  profile first.
- **Merge-heavy scenarios** (octopus / criss-cross merges) were not
  stress-tested beyond the kit's checks; the kit's merge checks all
  pass, but a deep merge graph could expose a slow `mergeBase` BFS.
  The BFS is bounded by the repo size in a trial, so this is a minor
  risk.
- **Real-git v0 fetch with haves** was verified through the kit client
  only, not through a real git client forcing protocol 0. The v0 code
  path mirrors v2 and the kit's v0 checks pass; a real-git v0 fetch is
  unlikely to be used by the grader (the kit client prefers v2).
