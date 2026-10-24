// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in compit-state.json, readable by the container user only
// (0600):
//   - `pausedUntil`: the end of a pause after an HTTP 429 or 5xx;
//   - `refused`: the account was refused (wrong e-mail or password, a token
//     refused right after a sign-in, a client registration not accepted):
//     a final stop, no automatic retry. Only saving other credentials, or a
//     successful "Test the connection", lifts it;
//   - `fp`: while refused only, a salted scrypt fingerprint (16 bytes, a
//     random salt per file) of the refused e-mail and password, so that a
//     restart tells whether the refusal still concerns the configured
//     account. Erased by the first successful sign-in: nothing in the file
//     can confirm a password that works;
//   - `lastLoginAt`: when the last sign-in left, so that a restart never
//     signs in twice within a minute;
//   - `stops`: the sticky "Summer" guards ([{ id, until }], a device id and
//     the end of its guard, 90 s at most), so that a restart goes on
//     writing "Summer" again if a "Winter" sent just before shows up.
// Never a secret in clear: no e-mail address, no password, no token. Read
// back bounded (a clock moved or a file edited by hand never gives a pause
// longer than its maximum), only known keys of the expected shape (never an
// inherited or `__proto__` key).
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/compit-state.json';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 4096 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file; `failing` refuses every save. */
export function memoryStore(initial = null, { failing = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    failing,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      if (this.failing) {
        throw new Error('EROFS');
      }
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const REASONS = new Set(['login', 'token', 'client']);

/** The persisted state, repaired and bounded against `now`. */
export function normalizeMemory(raw, now) {
  const pausedUntil = own(raw, 'pausedUntil');
  const lastLoginAt = own(raw, 'lastLoginAt');
  const salt = own(raw, 'salt');
  const refused = own(raw, 'refused');
  const fp = own(raw, 'fp');
  const reason = own(raw, 'reason');
  const isRefused = refused === true;
  return {
    pausedUntil:
      Number.isFinite(pausedUntil) && pausedUntil > now
        ? Math.min(pausedUntil, now + TIMINGS.pauseMax)
        : 0,
    // A time ahead of the clock counts as now (never a sign-in blocked for long).
    lastLoginAt: Number.isFinite(lastLoginAt) && lastLoginAt > 0 ? Math.min(lastLoginAt, now) : 0,
    salt:
      typeof salt === 'string' && /^[0-9a-f]{32}$/.test(salt)
        ? salt
        : randomBytes(16).toString('hex'),
    refused: isRefused,
    // A refusal without a readable fingerprint is kept (never lifted by guess).
    fp: isRefused && typeof fp === 'string' && /^[0-9a-f]{32}$/.test(fp) ? fp : '',
    reason: isRefused && REASONS.has(reason) ? reason : isRefused ? 'login' : '',
    stops: readStops(own(raw, 'stops'), now),
  };
}

const MAX_STOPS = 32;

function readStops(list, now) {
  if (!Array.isArray(list)) {
    return [];
  }
  const stops = [];
  for (const entry of list.slice(0, MAX_STOPS)) {
    const id = own(entry, 'id');
    const until = own(entry, 'until');
    if (Number.isSafeInteger(id) && id >= 0 && Number.isFinite(until) && until > now) {
      stops.push({ id, until: Math.min(until, now + TIMINGS.guard) });
    }
  }
  return stops;
}

/** The sticky guards still running, as they are kept in /data. */
export function stopsOf(guards, now) {
  const stops = [];
  for (const [key, guard] of guards) {
    const match = /^(\d{1,12}):season$/.exec(key);
    if (match && guard.sticky && guard.until > now && stops.length < MAX_STOPS) {
      stops.push({ id: Number(match[1]), until: guard.until });
    }
  }
  return stops;
}

export const serializeMemory = ({
  pausedUntil,
  lastLoginAt,
  salt,
  refused,
  fp,
  reason,
  stops,
}) => ({
  pausedUntil,
  lastLoginAt,
  salt,
  refused,
  fp: refused ? fp : '',
  reason: refused ? reason : '',
  stops: stops ?? [],
});

/** The salted fingerprint of the account secret (never the secret). */
export const fingerprint = (salt, secret) =>
  scryptSync(String(secret), `${salt}:compit-account`, 16).toString('hex');
