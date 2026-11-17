// The seeded scenario identity: a port of the kit's own generator
// (sdk/conformance/wire.ts: SCENARIO_SEED, Rng, generateUsers).
//
// Why this exists: every check names the token owner by login
// (scenario.viewer.login), but the entry never receives the login — only
// the bearer token (MAKEFUN_SHOP_TOKEN). The scenario is built once from
// the one constant SCENARIO_SEED, and wire.ts states live, replay and the
// entrant's local practice run all see byte-identical data, so the viewer
// login is a pure function of that seed. Porting the generator (instead of
// hardcoding the string) keeps the derivation honest and checkable.
//
// Verified against the kit: buildScenario() gives viewer adaiversen,
// teammate quinnkeller, stranger olgabauer.

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const MASK64 = (1n << 64n) - 1n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*, exactly as wire.ts: three shifts, one multiply. */
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & MASK64;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & MASK64;
    x = (x ^ (x << 25n)) & MASK64;
    x = (x ^ (x >> 27n)) & MASK64;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK64;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(list: readonly T[]): T {
    return list[this.nextInt(list.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < Math.max(0, Math.trunc(count)); i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${first}${last}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push(Object.freeze({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` }));
  }
  return users;
}

const users = generateUsers(new Rng(scenarioSeedFor('users')), 3);

/** The login the trial's bearer token names. */
export const VIEWER: ScenarioUser = users[0] as ScenarioUser;
/** A second user, with no rights on the viewer's repositories. */
export const STRANGER: ScenarioUser = users[2] as ScenarioUser;

/** The bearer token the trial env puts in the environment; entry auth.
 * When it is absent (local dev), a fixed dev token so auth is still
 * enforced and the unauthenticated checks still fail the same way. */
export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? 'local-dev-token';

/** The deterministic "now" for anything the forge generates (commit
 * timestamps, merged_at): MAKEFUN_TRIAL_NOW (ms) when the trial sets it,
 * else a fixed constant. Never Date.now() — a replay must match live. */
export function trialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  const ms = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  return 1700000000;
}

export function trialNowIso(): string {
  return new Date(trialNowSec() * 1000).toISOString();
}
