// Entry lifecycle for the trial env: bind an ephemeral port, register it with
// the env, then poll until the env reports the trial is done and exit 0.
// The trial scores the server in app.ts; this file only runs the handshake
// the harness expects, so its protocol below must stay exactly as specified:
//
//   1. MAKEFUN_ENV_URL holds the env origin (http://store:8080 in a trial).
//      With no env URL there is nothing to register with: exit 1 at once.
//   2. Start the server on port 0 so the kernel picks a free port. Never
//      bind 8080: the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the
//      caller's address plus N as this entry's base URL and dials it from
//      then on. The first register wins; a 409 means another entry already
//      registered, and this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers at once ({"done": false} while the suite runs), so this is
//      a poll, not a long-held request. A failed or slow poll is retried
//      with a short exponential backoff; the process never exits before
//      the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// main.ts imports its own server and nothing else: no package, no Node
// built-in, no model call.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Longest one register or done request may run before it is dropped. */
const REQ_TIMEOUT_MS = 30_000;
/** First pause between retries, and the longest pause. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Pause after `attempt` failed requests: exponential, capped at the max. */
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/** Run `fn` until it returns true, waiting longer between tries each time. */
async function retryUntil(fn: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (await fn()) return;
    await sleep(backoffMs(attempt));
  }
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer;
 * 409 means a first register already won, which is not this process's to
 * fix. 400 and 405 are contract errors and end the program; a network
 * error or another status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  await retryUntil(async () => {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return true;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) {
        throw err;
      }
    }
    return false;
  });
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  await retryUntil(async () => {
    try {
      const res = await fetch(`${ENV_URL}/done`, {
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return true;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not
      // done, so poll again.
    }
    return false;
  });
}

/** Bind the port, register it, then wait for the env: the whole life. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
