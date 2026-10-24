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
// The bodies of /authorize and /clients are sent as a form
// (application/x-www-form-urlencoded), as the reference does (aiohttp
// `data=dict`); the write of /params as JSON (aiohttp `json=`).
//
// Changes from the reference: the client registers under its own name
// (label "Gladys", a uid of its own per installation, kept in /data), never
// as another application; the registration is tried once per sign-in (the
// reference retries without end); 400, 401 and 403 of /authorize, a second
// 422, or a registration refused end with REFUSED (a final stop the app
// persists).
//
// The token has no documented lifetime. Only a 401 on the main resource
// (`/gates`) drops it; a 401 on the state of one device, on a fresh read or
// on a write never does: the app confirms the token on `/gates`
// (`confirmToken`). A dropped token is renewed by signing in again, never in
// a loop: once, only when it is older than a minute and no other sign-in
// happened within the minute (`mayLogin`, persisted by the app); a token
// refused right after a sign-in, or renewed three times without any read
// going through in between, ends with REFUSED. The e-mail address, the
// password and the token live in private fields only: never on a property
// a log could print.
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
   * @param {string} [options.uid] the uid of this installation (registered on the account)
   * @param {Function} [options.request] the HTTPS transport (tests inject a fake iNext)
   * @param {() => boolean} [options.mayLogin] whether a sign-in may leave now
   * @param {() => Promise<void>} [options.onLogin] called (and awaited) before a sign-in leaves
   */
  constructor({
    email,
    password,
    uid = COMPIT.clientUid,
    request = httpsRequest,
    now = Date.now,
    mayLogin = () => true,
    onLogin = async () => {},
  }) {
    this.#email = email;
    this.#password = password;
    this.uid = uid;
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

  /** Whether a token is held. */
  get hasSession() {
    return this.#token !== null;
  }

  /** Whether a sign-in is under way (a command may join it). */
  get signingIn() {
    return this.#login !== null;
  }

  /**
   * One request to the API: `{ data, serverTime }`. `answerBy`, `startBy`:
   * absolute times; `beforeSend`: the last check, called once by the
   * transport when the connection is up, right before the request leaves
   * (never before: its effects belong to a request that really leaves);
   * `token`: a token other than the session's (the registration); `form`:
   * the body sent as a form.
   */
  async exchange(
    method,
    path,
    {
      body,
      form = false,
      answerBy,
      startBy,
      beforeSend,
      auth = true,
      token: given,
      ignoreBody = false,
    } = {},
  ) {
    if (this.closed) {
      throw new CompitError(CODES.CLOSED);
    }
    const now = this.now();
    const timeout = answerBy === undefined ? TIMINGS.requestTimeout : answerBy - now;
    if (timeout <= 0 || (startBy !== undefined && startBy <= now)) {
      throw new CompitError(CODES.LATE);
    }
    const token = given ?? this.#token;
    if (auth && token === null) {
      throw new CompitError(CODES.NO_SESSION);
    }
    let text;
    if (body !== undefined) {
      text = form ? formOf(body) : JSON.stringify(body);
    }
    let answer;
    try {
      answer = await this.request({
        method,
        url: `${COMPIT.apiUrl}${path}`,
        headers: auth ? { authorization: token } : {},
        body: text,
        ...(form ? { contentType: 'application/x-www-form-urlencoded' } : {}),
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
    if (answer.status < 200 || answer.status > 299) {
      const error = new CompitError(CODES.HTTP, {
        status: answer.status,
        retryAfterMs: retryAfterMs(answer.headers?.['retry-after'], this.now()),
        sent: true,
      });
      error.token = token;
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
    const content = ignoreBody ? '' : String(answer.body ?? '');
    return {
      data: content.trim() === '' ? null : parseJson(content),
      serverTime: serverTimeOf(answer.headers),
    };
  }

  /**
   * Signs in (one at a time: a second caller joins the sign-in under way).
   * REFUSED for a refused account; NO_SESSION within the minute.
   * `answerBy`: the deadline of each of its requests (a command's budget).
   */
  login({ answerBy } = {}) {
    if (!this.#login) {
      this.#login = this.signIn({ answerBy }).finally(() => {
        this.#login = null;
      });
    }
    return this.#login;
  }

  authorize(answerBy) {
    return this.exchange('POST', '/authorize', {
      body: {
        email: this.#email,
        password: this.#password,
        uid: this.uid,
        label: COMPIT.clientLabel,
      },
      form: true,
      auth: false,
      answerBy,
    });
  }

  async signIn({ answerBy } = {}) {
    if (!this.mayLogin()) {
      throw new CompitError(CODES.NO_SESSION);
    }
    // The time of this sign-in is saved before it leaves (the minute between two holds across a crash).
    await this.onLogin();
    let answer;
    try {
      answer = await this.authorize(answerBy);
    } catch (err) {
      if (!(err.code === CODES.HTTP && err.status === 422)) {
        throw refusedLogin(err);
      }
      // First sign-in of this client: registered once, then authorized once more.
      await this.register(err.registration, answerBy);
      try {
        answer = await this.authorize(answerBy);
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

  async register(token, answerBy) {
    if (!validToken(token)) {
      throw new CompitError(CODES.REFUSED, { status: 422, sent: true, reason: 'client' });
    }
    try {
      await this.exchange('POST', '/clients', {
        // aiohttp drops nothing: the reference sends fcm_token=None; an
        // empty value here (to check on a real account, see TODO.md).
        body: { fcm_token: '', uid: this.uid, label: COMPIT.clientLabel },
        form: true,
        token,
        ignoreBody: true,
        answerBy,
      });
    } catch (err) {
      if (err.code === CODES.HTTP && [400, 401, 403, 404, 409, 422].includes(err.status)) {
        throw new CompitError(CODES.REFUSED, { status: err.status, sent: true, reason: 'client' });
      }
      throw err;
    }
  }

  /**
   * The token was refused by the main resource: dropped, then renewed once
   * when it is older than the minute; else REFUSED (never a loop).
   */
  async renew(refused) {
    if (refused !== undefined && this.#token !== refused) {
      // Already renewed by someone else meanwhile.
      if (this.#token === null) {
        await this.login();
      }
      return;
    }
    this.#token = null;
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
  }

  /** The main resource (the gates): signs in when needed, renews a refused token once. */
  async read(path) {
    if (this.#token === null) {
      await this.login();
    }
    try {
      return this.accepted(await this.exchange('GET', path));
    } catch (err) {
      if (!(err.code === CODES.HTTP && err.status === 401)) {
        throw err;
      }
      await this.renew(err.token);
      try {
        return this.accepted(await this.exchange('GET', path));
      } catch (again) {
        if (again.code === CODES.HTTP && again.status === 401) {
          this.#token = null;
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

  /**
   * After a 401 on a secondary resource: is the token still good? 'valid'
   * when `/gates` reads with it, 'renewed' when `/gates` refused it too and
   * it was renewed; REFUSED, NO_SESSION or any error of `/gates` else.
   */
  async confirmToken() {
    if (this.#token === null) {
      await this.login();
      return 'renewed';
    }
    try {
      this.accepted(await this.exchange('GET', '/gates'));
      return 'valid';
    } catch (err) {
      if (!(err.code === CODES.HTTP && err.status === 401)) {
        throw err;
      }
      await this.renew(err.token);
      return 'renewed';
    }
  }

  /** The state of one device. A 401/403 here never drops the token. */
  state(deviceId) {
    return this.exchange('GET', `/devices/${deviceSegment(deviceId)}/state`);
  }

  // --- The commands: deadlines given by the app ------------------------------

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

/** A form body (application/x-www-form-urlencoded); null and undefined as empty. */
export function formOf(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.append(key, value === null || value === undefined ? '' : String(value));
  }
  return params.toString();
}

/**
 * /authorize refused: a final stop for 400 (the request: its cause cannot be
 * told), 401 and 403 (the credentials); anything else as it is.
 */
function refusedLogin(err) {
  if (err.code === CODES.HTTP && [400, 401, 403].includes(err.status)) {
    const reason = err.status === 400 ? 'request' : 'login';
    return new CompitError(CODES.REFUSED, { status: err.status, sent: true, reason });
  }
  return err;
}
