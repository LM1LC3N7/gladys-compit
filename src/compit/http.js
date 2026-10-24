// -----------------------------------------------------------------------------
// The only network access of the integration: one HTTPS request to the Compit
// API on node:https. A deadline for the whole exchange, a size cap on the
// body, no redirect followed, no keep-alive, no User-Agent of an app (Node
// sends none). Resolves { status, headers, body } for any status; rejects a
// CompitError for the transport failures, with `sent` true as soon as the TLS
// connection was up and the request written (it may then have reached
// Compit). `sendWithin`: the connection must be up within this many ms, else
// nothing is written (a command never leaves late).
// -----------------------------------------------------------------------------

import https from 'node:https';
import { CompitError, CODES } from './errors.js';

/** Only our code: a message may carry an address or a header value. */
const transportError = (sent) => new CompitError(CODES.UNREACHABLE, { sent });

/**
 * @param {object} options
 * @param {'GET' | 'POST' | 'PUT'} options.method
 * @param {string} options.url an https:// address
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body] a JSON text
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} [options.sendWithin] ms to have the connection up, else not sent
 * @param {number} options.maxBytes body size cap
 * @param {() => void} [options.beforeSend] called once connected, right before
 *   the request is written; if it throws, nothing is sent and its error is
 *   passed on with `beforeSend` set
 */
export function httpsRequest({
  method,
  url,
  headers = {},
  body,
  timeout,
  sendWithin,
  maxBytes,
  beforeSend,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    let connected = false;

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () => finish(new CompitError(CODES.TIMEOUT, { sent: connected })),
      Math.max(1, timeout),
    );
    const sendTimer =
      sendWithin === undefined
        ? null
        : setTimeout(
            () => {
              if (!connected) {
                finish(new CompitError(CODES.LATE));
              }
            },
            Math.max(0, sendWithin),
          );
    const markConnected = () => {
      if (connected || settled) {
        return;
      }
      clearTimeout(sendTimer);
      // The very last check of a command, once the connection is up and
      // right before the first byte is written: a refusal here destroys the
      // socket, nothing sent.
      if (beforeSend) {
        try {
          beforeSend();
        } catch (err) {
          err.beforeSend = true;
          err.sent = false;
          finish(err);
          return;
        }
      }
      connected = true;
      req.end(body ?? undefined);
    };

    try {
      const target = new URL(url);
      if (target.protocol !== 'https:') {
        finish(transportError(false));
        return;
      }
      const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
      req = https.request(target, {
        method,
        agent: false,
        headers: {
          accept: 'application/json',
          connection: 'close',
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
            : {}),
          ...headers,
        },
      });
      req.on('response', (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new CompitError(CODES.TOO_LARGE, { sent: true }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', () => finish(transportError(true)));
      });
      req.on('socket', (socket) => {
        // TLS, a fresh socket each time (no agent): the request leaves once
        // the handshake is done.
        socket.once('secureConnect', markConnected);
      });
      req.on('error', () => finish(transportError(connected)));
    } catch {
      // A header Node refuses (an invisible character): a failure, never a crash.
      finish(transportError(false));
    }
  });
}
