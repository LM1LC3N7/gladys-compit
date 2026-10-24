// -----------------------------------------------------------------------------
// The Compit iNext API, as compit-inext-api 0.9.2 (Apache-2.0, Przemko92)
// uses it (api.py):
//   - POST /authorize { email, password, uid, label } -> { token, gates }:
//     the token is then sent as is in the `Authorization` header;
//     401: wrong credentials; 422: this client is not registered on the
//     account yet (the answer carries a token for the registration);
//   - POST /clients { fcm_token: null, uid, label }: the registration, then
//     /authorize once more;
//   - GET /gates: the gates and their devices;
//   - GET /devices/{id}/state: the parameters of a device;
//   - PUT /devices/{id}/params { values: [{ code, value }] }: a write.
//
// Changes from the reference: the client registers under its own name
// ("Gladys", uid "gladys-compit"), never as another application; the
// registration is tried once per sign-in (the reference retries without
// end); 400, 401 and 403 of /authorize, a second 422, or a registration
// refused end with REFUSED (a final stop the app persists).
//
// The token has no documented lifetime: it is renewed by signing in again,
// never in a loop: a refused token is renewed once, only when it is older
// than a minute and no other sign-in happened within the minute
// (`mayLogin`, persisted by the app); a token refused right after a
// sign-in, or renewed three times without any read going through in
// between, ends with REFUSED. The e-mail address, the password and the
// token live in private fields only: never on a property a log could print.
// -----------------------------------------------------------------------------

import { COMPIT, LIMITS, TIMINGS } from '../constants.js';
import { CODES, CompitError } from './errors.js';
import { httpsRequest } from './http.js';

/** Retry-After: seconds or an HTTP date, in ms (undefined when absent or unreadable). */
export function retryAfterMs(value, now) {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || text.length > 64) {
    return undefined;
  }
  if (/^\s*\d{1,7}\s*$/.test(text)) {
    return Number(text) * 1000;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** The `Date` header of an answer, in ms, else undefined (never "now" by guess). */
export function serverTimeOf(headers) {
  const text = headers?.date;
  if (typeof text !== 'string' || text.length > 64) {
    return undefined;
  }
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : undefined;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** JSON, keys that could reach a prototype dropped; BAD_ANSWER when it is not JSON. */
export function parseJson(text) {
  try {
    return JSON.parse(text, (key, value) => (UNSAFE_KEYS.has(key) ? undefined : value));
  } catch {
    throw new CompitError(CODES.BAD_ANSWER, { sent: true });
  }
}

/** A device id that may go into a path, else an error. */
function deviceSegment(value) {
  const text = String(value);
  if (!/^\d{1,12}$/.test(text)) {
    throw new Error('bad id');
  }
  return text;
}

/** A token as the API may give it: printable ASCII, bounded. */
const validToken = (token) =>
  typeof token === 'string' &&
  token !== '' &&
  token.length <= LIMITS.tokenLength &&
  !/[^\x21-\x7e]/.test(token);

export class CompitClient {
  #email;
  #password;
  #token = null;
  #tokenAt = 0;
  #login = null;
  /** Token renewals (after a 401) since the last read that went through. */
  #renewals = 0;

  /**
   * @param {object} options
   * @param {string} options.email
   * @param {string} options.password
   * @param {Function} [options.request] the HTTPS transport (tests inject a fake iNext)
   * @param {() => boolean} [options.mayLogin] whether a sign-in may leave now
   * @param {() => Promise<void>} [options.onLogin] called (and awaited) before a sign-in leaves
   */
  constructor({
    email,
    password,
    request = httpsRequest,
    now = Date.now,
    mayLogin = () => true,
    onLogin = async () => {},
  }) {
    this.#email = email;
    this.#password = password;
    this.request = request;
    this.now = now;
    this.mayLogin = mayLogin;
    this.onLogin = onLogin;
    this.closed = false;
  }

  close() {
    this.closed = true;
    this.#token = null;
  }

  /** Whether a token is held (for the commands: they never sign in). */
  get hasSession() {
    return this.#token !== null;
  }

  /**
   * One request to the API: `{ data, serverTime }`. `answerBy`, `startBy`:
   * absolute times; `beforeSend`: the last check, right before the request
   * leaves; `token`: a token other than the session's (the registration).
   */
  async exchange(
    method,
    path,
    { body, answerBy, startBy, beforeSend, auth = true, token: given, ignoreBody = false } = {},
  ) {
    if (this.closed) {
      throw new CompitError(CODES.CLOSED);
    }
    const now = this.now();
    const timeout = answerBy === undefined ? TIMINGS.requestTimeout : answerBy - now;
    if (timeout <= 0 || (startBy !== undefined && startBy <= now)) {
      throw new CompitError(CODES.LATE);
    }
    if (beforeSend) {
      try {
        beforeSend();
      } catch (err) {
        err.beforeSend = true;
        throw err;
      }
    }
    const token = given ?? this.#token;
    if (auth && token === null) {
      throw new CompitError(CODES.NO_SESSION);
    }
    let answer;
    try {
      answer = await this.request({
        method,
        url: `${COMPIT.apiUrl}${path}`,
        headers: auth ? { authorization: token } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
        timeout,
        ...(startBy === undefined ? {} : { sendWithin: startBy - now }),
        maxBytes: LIMITS.responseBytes,
        ...(beforeSend ? { beforeSend } : {}),
      });
    } catch (err) {
      if (err instanceof CompitError || err?.beforeSend) {
        throw err;
      }
      throw new CompitError(CODES.UNREACHABLE);
    }
    if (this.closed) {
      throw new CompitError(CODES.CLOSED, { sent: true });
    }
    if (answer.status === 401 && auth && given === undefined && this.#token === token) {
      // This token is refused: the next read signs in again (never in a loop).
      this.#token = null;
    }
    if (answer.status < 200 || answer.status > 299) {
      const error = new CompitError(CODES.HTTP, {
        status: answer.status,
        retryAfterMs: retryAfterMs(answer.headers?.['retry-after'], this.now()),
        sent: true,
      });
      if (answer.status === 422 && !auth) {
        // /authorize: the token of the registration is in the body of the 422.
        try {
          error.registration = parseJson(String(answer.body ?? ''))?.token;
        } catch {
          error.registration = undefined;
        }
      }
      throw error;
    }
    // A write accepted (2xx) is accepted, whatever its body says.
    const text = ignoreBody ? '' : String(answer.body ?? '');
    return {
      data: text.trim() === '' ? null : parseJson(text),
      serverTime: serverTimeOf(answer.headers),
    };
  }

  /** Signs in (one at a time). REFUSED for a refused account; NO_SESSION within the minute. */
  login() {
    if (!this.#login) {
      this.#login = this.signIn().finally(() => {
        this.#login = null;
      });
    }
    return this.#login;
  }

  authorize() {
    return this.exchange('POST', '/authorize', {
      body: {
        email: this.#email,
        password: this.#password,
        uid: COMPIT.clientUid,
        label: COMPIT.clientLabel,
      },
      auth: false,
    });
  }

  async signIn() {
    if (!this.mayLogin()) {
      throw new CompitError(CODES.NO_SESSION);
    }
    // The time of this sign-in is saved before it leaves (the minute between two holds across a crash).
    await this.onLogin();
    let answer;
    try {
      answer = await this.authorize();
    } catch (err) {
      if (!(err.code === CODES.HTTP && err.status === 422)) {
        throw refusedLogin(err);
      }
      // First sign-in of this client: registered once, then authorized once more.
      await this.register(err.registration);
      try {
        answer = await this.authorize();
      } catch (again) {
        if (again.code === CODES.HTTP && again.status === 422) {
          throw new CompitError(CODES.REFUSED, { status: 422, sent: true, reason: 'client' });
        }
        throw refusedLogin(again);
      }
    }
    const token = answer.data?.token;
    if (!validToken(token)) {
      throw new CompitError(CODES.BAD_ANSWER, { sent: true });
    }
    this.#token = token;
    this.#tokenAt = this.now();
  }

  async register(token) {
    if (!validToken(token)) {
      throw new CompitError(CODES.REFUSED, { status: 422, sent: true, reason: 'client' });
    }
    try {
      await this.exchange('POST', '/clients', {
        body: { fcm_token: null, uid: COMPIT.clientUid, label: COMPIT.clientLabel },
        token,
        ignoreBody: true,
      });
    } catch (err) {
      if (err.code === CODES.HTTP && [400, 401, 403, 404, 409, 422].includes(err.status)) {
        throw new CompitError(CODES.REFUSED, { status: err.status, sent: true, reason: 'client' });
      }
      throw err;
    }
  }

  /**
   * A read of the polling: signs in when no token is held; a token refused
   * (401) is renewed once when it is older than the minute, else REFUSED.
   * `renew: false` (a secondary resource): a 401 or 403 is passed on as is.
   */
  async read(path, { renew = true } = {}) {
    if (this.#token === null) {
      await this.login();
    }
    try {
      return this.accepted(await this.exchange('GET', path));
    } catch (err) {
      if (!renew || !(err.code === CODES.HTTP && err.status === 401)) {
        throw err;
      }
      if (
        this.now() - this.#tokenAt < TIMINGS.loginFloor ||
        this.#renewals >= LIMITS.renewalsWithoutRead
      ) {
        // Refused right after a sign-in, or renewed again and again without
        // a single read: the account cannot read this. A stop, not a loop.
        throw new CompitError(CODES.REFUSED, { status: 401, sent: true, reason: 'token' });
      }
      this.#renewals += 1;
      await this.login();
      try {
        return this.accepted(await this.exchange('GET', path));
      } catch (again) {
        if (again.code === CODES.HTTP && again.status === 401) {
          throw new CompitError(CODES.REFUSED, { status: 401, sent: true, reason: 'token' });
        }
        throw again;
      }
    }
  }

  /** A read went through: the renewals count from zero again. */
  accepted(answer) {
    this.#renewals = 0;
    return answer;
  }

  /** The gates of the account and their devices (checked by src/model.js). */
  gates() {
    return this.read('/gates');
  }

  /** The state of one device. A 401/403 here never renews the token (the gates read). */
  state(deviceId) {
    return this.read(`/devices/${deviceSegment(deviceId)}/state`, { renew: false });
  }

  // --- The commands: never a sign-in, deadlines given by the app ------------

  /** A fresh read of one device for a command (NO_SESSION without a token). */
  freshState(deviceId, options) {
    return this.exchange('GET', `/devices/${deviceSegment(deviceId)}/state`, options);
  }

  /** One parameter written (compit-inext-api update_device_parameter). */
  setParameter(deviceId, code, value, options) {
    return this.exchange('PUT', `/devices/${deviceSegment(deviceId)}/params`, {
      body: { values: [{ code, value }] },
      ...options,
      ignoreBody: true,
    });
  }
}

/** /authorize refused: a final stop for 400, 401, 403; anything else as it is. */
function refusedLogin(err) {
  if (err.code === CODES.HTTP && [400, 401, 403].includes(err.status)) {
    return new CompitError(CODES.REFUSED, { status: err.status, sent: true, reason: 'login' });
  }
  return err;
}
