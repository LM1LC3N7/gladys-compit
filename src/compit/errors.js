// -----------------------------------------------------------------------------
// CompitError: every failure of a request to the Compit iNext API, with a
// code the app maps to a status, a retry policy or a message. Messages are built here
// from codes and HTTP statuses only: never the text of an answer, never a
// header (the token), never the e-mail address nor the password.
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  UNREACHABLE: 'unreachable', // no connection, or it dropped
  TIMEOUT: 'timeout', // no answer in time
  HTTP: 'http', // an HTTP status other than 2xx (see `status`)
  BAD_ANSWER: 'bad answer', // not the JSON expected
  TOO_LARGE: 'answer too large', // above the size cap
  LATE: 'late', // could not start before its deadline: nothing sent
  CLOSED: 'closed', // the client was replaced (new configuration)
  REFUSED: 'credentials refused', // the account was refused (see `reason`)
  NO_SESSION: 'no session', // no token, and no sign-in allowed now
});

export class CompitError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {object} [details]
   * @param {number} [details.status] the HTTP status
   * @param {number} [details.retryAfterMs] a Retry-After, in ms
   * @param {boolean} [details.sent] the request may have reached Compit
   * @param {'login' | 'token' | 'client'} [details.reason] why REFUSED: the
   *   sign-in, a token refused right after it, the client registration
   */
  constructor(code, { status, retryAfterMs, sent = false, reason } = {}) {
    super(status === undefined ? code : `HTTP ${status}`);
    this.name = 'CompitError';
    this.code = code;
    this.sent = sent;
    if (status !== undefined) {
      this.status = status;
    }
    if (reason !== undefined) {
      this.reason = reason;
    }
    if (retryAfterMs !== undefined && retryAfterMs !== null) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

/** The account was refused: wrong e-mail or password, a fresh token refused, no client. */
export const isAuthRefused = (err) => err?.code === CODES.REFUSED;

/** Busy (429) or failing (5xx): a pause, persisted. */
export const isBusy = (err) =>
  err?.code === CODES.HTTP && (err.status === 429 || (err.status >= 500 && err.status <= 599));

/** A short reason for a status or a log: a code or an HTTP status, nothing else. */
export const reasonOf = (err) =>
  err instanceof CompitError ? err.message : String(err?.code ?? 'error').slice(0, 40);
