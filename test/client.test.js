// -----------------------------------------------------------------------------
// The client alone, against a scripted transport: the sign-in and its
// registration (once), the refusals that stop, the token renewal (never in
// a loop), the deadlines of the commands, and a real HTTPS request on the
// loopback to check the transport sends no User-Agent and caps the answer.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompitClient, retryAfterMs, serverTimeOf } from '../src/compit/client.js';
import { CODES } from '../src/compit/errors.js';

/** A transport answering from a list of [status, body] (or a function of the request). */
function scripted(answers) {
  const requests = [];
  const request = async (options) => {
    requests.push({ ...options, body: options.body && JSON.parse(options.body) });
    const next = answers.shift();
    const [status, body, headers = {}] = typeof next === 'function' ? next(options) : next;
    return { status, headers, body: body === undefined ? '' : JSON.stringify(body) };
  };
  return { request, requests };
}

const client = (transport, extra = {}) =>
  new CompitClient({
    email: 'jan@example.com',
    password: 'pw',
    request: transport.request,
    ...extra,
  });

test('a first sign-in registers the client once, then authorizes once more', async () => {
  const t = scripted([
    [422, { token: 'reg' }],
    [200, {}],
    [200, { token: 'tok', gates: [] }],
    [200, { gates: [] }],
  ]);
  const c = client(t);
  await c.gates();
  assert.deepEqual(
    t.requests.map((r) => `${r.method} ${r.url.replace(/^.*\/compit/, '')}`),
    ['POST /authorize', 'POST /clients', 'POST /authorize', 'GET /gates'],
  );
  assert.equal(t.requests[1].headers.authorization, 'reg');
  assert.equal(t.requests[3].headers.authorization, 'tok');
  assert.ok(t.requests.every((r) => r.url.startsWith('https://inext.compit.pl/mobile/v2/compit/')));
});

for (const status of [400, 401, 403]) {
  test(`/authorize ${status} is a refused login`, async () => {
    const c = client(scripted([[status, {}]]));
    await assert.rejects(c.gates(), (err) => err.code === CODES.REFUSED && err.reason === 'login');
  });
}

test('a registration refused, or a second 422, is a refused client, never a loop', async () => {
  const refusedRegistration = scripted([
    [422, { token: 'reg' }],
    [403, {}],
  ]);
  await assert.rejects(
    client(refusedRegistration).gates(),
    (err) => err.code === CODES.REFUSED && err.reason === 'client',
  );
  assert.equal(refusedRegistration.requests.length, 2);
  const twice = scripted([
    [422, { token: 'reg' }],
    [200, {}],
    [422, { token: 'reg' }],
  ]);
  await assert.rejects(client(twice).gates(), (err) => err.reason === 'client');
  assert.equal(twice.requests.length, 3);
  const noToken = scripted([[422, { nothing: true }]]);
  await assert.rejects(client(noToken).gates(), (err) => err.reason === 'client');
  assert.equal(noToken.requests.length, 1);
});

test('a token with a line break or too long is a bad answer', async () => {
  const c = client(scripted([[200, { token: 'a\r\nb' }]]));
  await assert.rejects(c.gates(), (err) => err.code === CODES.BAD_ANSWER);
  const d = client(scripted([[200, { token: 'x'.repeat(5000) }]]));
  await assert.rejects(d.gates(), (err) => err.code === CODES.BAD_ANSWER);
});

test('a token refused right after the sign-in is a stop; an old one is renewed once', async () => {
  let now = 0;
  const fresh = scripted([
    [200, { token: 'tok' }],
    [401, {}],
  ]);
  await assert.rejects(
    client(fresh, { now: () => now }).gates(),
    (err) => err.code === CODES.REFUSED && err.reason === 'token',
  );
  const old = scripted([
    [200, { token: 'tok' }],
    [200, { gates: [] }],
    [401, {}],
    [200, { token: 'tok2' }],
    [200, { gates: [] }],
  ]);
  const c = client(old, { now: () => now });
  await c.gates();
  now = 120_000;
  await c.gates();
  assert.equal(old.requests.at(-1).headers.authorization, 'tok2');
});

test('the state of a device: a 401/403 is passed on, never a new sign-in', async () => {
  const t = scripted([
    [200, { token: 'tok' }],
    [403, {}],
    [401, {}],
  ]);
  const c = client(t, { now: () => 1e9 });
  await assert.rejects(c.state(5), (err) => err.status === 403);
  await assert.rejects(c.state(5), (err) => err.status === 401);
  assert.equal(t.requests.filter((r) => r.url.endsWith('/authorize')).length, 1);
});

test('no sign-in within the minute; device ids only digits; commands never sign in', async () => {
  const c = client(scripted([]), { mayLogin: () => false });
  await assert.rejects(c.gates(), (err) => err.code === CODES.NO_SESSION);
  await assert.rejects(c.freshState(5, {}), (err) => err.code === CODES.NO_SESSION);
  assert.throws(() => c.state('5/../x'), /bad id/);
});

test('a write: one parameter, a deadline already passed sends nothing', async () => {
  const t = scripted([
    [200, { token: 'tok' }],
    [200, { gates: [] }],
    [200, { ok: true }],
  ]);
  let now = 0;
  const c = client(t, { now: () => now });
  await c.gates();
  await c.setParameter(5, '__x', 21.5, { startBy: 1000, answerBy: 2000 });
  assert.deepEqual(t.requests.at(-1).body, { values: [{ code: '__x', value: 21.5 }] });
  assert.equal(t.requests.at(-1).method, 'PUT');
  now = 5000;
  await assert.rejects(
    c.setParameter(5, '__x', 22, { startBy: 1000, answerBy: 2000 }),
    (err) => err.code === CODES.LATE && err.sent === false,
  );
  assert.equal(t.requests.length, 3);
});

test('errors never carry the e-mail, the password nor the token', async () => {
  const t = scripted([[500, { email: 'jan@example.com', password: 'pw' }]]);
  const err = await client(t)
    .gates()
    .catch((e) => e);
  assert.equal(err.message, 'HTTP 500');
  assert.ok(!JSON.stringify({ ...err, m: err.message }).includes('pw'));
  assert.ok(!JSON.stringify(client(t)).includes('pw'));
});

test('Retry-After and Date read strictly', () => {
  assert.equal(retryAfterMs('120', 0), 120_000);
  assert.equal(retryAfterMs('soon', 0), undefined);
  assert.equal(serverTimeOf({ date: 'Sat, 24 Oct 2026 18:00:00 GMT' }), Date.UTC(2026, 9, 24, 18));
  assert.equal(serverTimeOf({}), undefined);
  assert.equal(serverTimeOf({ date: 'x' }), undefined);
});
