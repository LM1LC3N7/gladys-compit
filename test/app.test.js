// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys and a fake Compit iNext API behind the injected HTTPS transport.
// Timers and Date are mocked: the tests move the clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CompitApp } from '../src/app.js';
import { ACTIONS, HOUR, MINUTE, SECOND } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  BOILER,
  EMAIL,
  MIXER,
  NOW,
  PASSWORD,
  THERMOSTAT,
  fakeCompit,
  settle,
} from './fixtures/fakeCompit.js';

const CONFIG = { email: EMAIL, password: PASSWORD };
const SETPOINTS = { ...CONFIG, allow_setpoints: true };
const DHW = { ...CONFIG, allow_dhw: true };
const SEASONS = { ...CONFIG, allow_seasons: true };
const device = (id) => `ext:test-integration:compit:${id}`;
const feature = (id, role) => `${device(id)}:${role}`;

const mocked = new WeakSet();
/** One poll interval (120 s) and the time of its requests. */
const POLL = 2 * MINUTE + 10 * SECOND;

async function setup(
  t,
  {
    config = CONFIG,
    compit = fakeCompit(),
    create = true,
    store = memoryStore(),
    logs = [],
    now = NOW,
  } = {},
) {
  // A second setup in the same test (a restart) keeps the mocked clock.
  if (!mocked.has(t)) {
    mocked.add(t);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  }
  const gladys = createFakeGladys({ config });
  const app = new CompitApp({
    gladys,
    logger: recorder(logs),
    request: compit.request,
    store,
    now: () => Date.now(),
    // The monotonic clock follows the mocked one (performance.now is not mocked).
    clock: () => Date.now(),
  });
  registerHandlers(gladys, app);
  const advance = async (ms, step = 100) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      t.mock.timers.tick(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  const connecting = gladys.connect();
  await settle();
  await advance(2 * SECOND, 50);
  await connecting;
  t.after(() => app.stop());
  if (create) {
    for (const d of [...gladys.fake.discoveredDevices]) {
      await gladys.fake.deviceCreated(d);
    }
    await settle();
  }
  /** A command on a feature of a created device; resolves with the ack. */
  const command = async (id, role, value, { wait = 5 * SECOND } = {}) => {
    const d = gladys.fake.devices.find((x) => x.external_id === device(id));
    const target = d.features.find((f) => f.external_id === feature(id, role)) ?? {
      external_id: feature(id, role),
    };
    let ack;
    gladys.fake.setValue(d, target, value).then((a) => (ack = a));
    await settle();
    await advance(wait, 50);
    return ack;
  };
  return { gladys, app, compit, advance, logs, command, store };
}

const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

const last = (gladys, id, role) => gladys.fake.lastState(feature(id, role));
const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
const logins = (compit) => compit.requests.filter((r) => r.path === '/authorize').length;
const roles = (d) => d.features.map((f) => f.external_id.slice(d.external_id.length + 1));
const ok = (ack) => assert.equal(ack?.success, true, JSON.stringify(ack));
const refused = (ack, pattern) => {
  assert.equal(ack?.success, false, JSON.stringify(ack));
  assert.match(ack.error, pattern);
};

/** No secret anywhere a user or a file could show. */
function assertNoSecret({ logs, store, gladys }) {
  const seen = [
    ...logs,
    JSON.stringify(store.data ?? {}),
    JSON.stringify(gladys.fake.connectionStatus ?? {}),
    JSON.stringify(gladys.fake.discoveredDevices),
  ].join('\n');
  for (const secret of [EMAIL, PASSWORD, 'token-1', 'token-2', 'registration-token']) {
    assert.ok(!seen.includes(secret), `${secret} leaked`);
  }
}

test('an empty configuration asks for the account and reads nothing', async (t) => {
  const { gladys, compit } = await setup(t, { config: {} });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /adresse e-mail et le mot de passe/);
  assert.equal(compit.requests.length, 0);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /e-mail address and the password/);
});

test('registers Gladys once under its own name, signs in, lists and reads the devices', async (t) => {
  const logs = [];
  const { gladys, compit, store } = await setup(t, { logs });
  assert.deepEqual(
    compit.requests.map((r) => `${r.method} ${r.path}`),
    [
      'POST /authorize',
      'POST /clients',
      'POST /authorize',
      'GET /gates',
      `GET /devices/${THERMOSTAT}/state`,
      `GET /devices/${BOILER}/state`,
      `GET /devices/${MIXER}/state`,
    ],
  );
  const [first, register] = compit.requests;
  assert.deepEqual(Object.keys(first.body).sort(), ['email', 'label', 'password', 'uid']);
  assert.equal(first.body.uid, 'gladys-compit');
  assert.equal(first.body.label, 'Gladys');
  assert.deepEqual(register.body, { fcm_token: null, uid: 'gladys-compit', label: 'Gladys' });
  assert.equal(register.auth, 'registration-token');
  assert.equal(compit.requests[3].auth, 'token-1', 'the token as is, as the reference sends it');
  assert.ok(
    compit.requests.every((r) => !JSON.stringify(r).includes('HomeAssistant')),
    'never the name of another application',
  );
  assert.ok(compit.requests.every((r) => r.headers['user-agent'] === undefined));
  const found = gladys.fake.discoveredDevices.map((d) => d.external_id).sort();
  assert.deepEqual(found, [device(THERMOSTAT), device(BOILER), device(MIXER)].sort());
  const thermostat = gladys.fake.discoveredDevices.find(
    (d) => d.external_id === device(THERMOSTAT),
  );
  assert.equal(thermostat.name, 'Salon (Compit)');
  assert.equal(thermostat.model, 'Compit Nano Color 2');
  assert.deepEqual(roles(thermostat), [
    'room-temperature',
    'room-target',
    'setpoint',
    'season',
    'outdoor-temperature',
    'alarms',
    'status',
  ]);
  const boiler = gladys.fake.discoveredDevices.find((d) => d.external_id === device(BOILER));
  assert.deepEqual(roles(boiler), [
    'outdoor-temperature',
    'boiler-temperature',
    'dhw-temperature',
    'dhw-setpoint',
    'fuel-level',
    'alarms',
    'status',
  ]);
  for (const d of gladys.fake.discoveredDevices) {
    assert.ok(
      d.features.every((f) => f.category !== 'switch' && f.type !== 'binary'),
      'never a switch nor a binary',
    );
  }
  const byRole = (d, role) => d.features.find((f) => f.external_id.endsWith(`:${role}`));
  assert.equal(byRole(thermostat, 'setpoint').category, 'thermostat');
  assert.equal(byRole(thermostat, 'setpoint').max, 30);
  assert.equal(byRole(boiler, 'dhw-setpoint').max, 60);
  assert.deepEqual(
    byRole(thermostat, 'season').supported_options.map((o) => o.value),
    ['winter', 'summer', 'cooling'],
  );
  assert.equal(byRole(boiler, 'fuel-level').unit, 'percent');
  assert.equal(last(gladys, THERMOSTAT, 'room-temperature'), 21.4);
  assert.equal(last(gladys, THERMOSTAT, 'setpoint'), 20);
  assert.equal(last(gladys, THERMOSTAT, 'season'), 'winter');
  assert.equal(last(gladys, BOILER, 'alarms'), 'E12 Czujnik CWU');
  assert.equal(last(gladys, MIXER, 'mixer-temperature'), 38.2);
  assert.equal(last(gladys, MIXER, 'alarms'), 'Aucune alarme');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).en, /1 iNext module\(s\), 3 device\(s\)/);
  assertNoSecret({ logs, store, gladys });
});

test('reads every interval with the same token, never signing in again', async (t) => {
  const { compit, advance } = await setup(t, { compit: fakeCompit({ registered: true }) });
  assert.equal(logins(compit), 1);
  await advance(10 * MINUTE, SECOND);
  assert.equal(logins(compit), 1);
  const reads = compit.requests.filter((r) => r.path === `/devices/${THERMOSTAT}/state`).length;
  assert.equal(reads, 5, 'one read per interval of 120 s, counted from the end of the previous');
});

test('a refused token is renewed once, then reads go on', async (t) => {
  const { compit, advance, gladys } = await setup(t, { compit: fakeCompit({ registered: true }) });
  await advance(2 * MINUTE, SECOND);
  compit.revokeTokens();
  await advance(2 * MINUTE, SECOND);
  assert.equal(logins(compit), 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a refused password is a final stop: persisted, never retried, a restart keeps it', async (t) => {
  const logs = [];
  const store = memoryStore();
  const compit = fakeCompit({ password: 'other', registered: true });
  const { gladys, advance } = await setup(t, { compit, store, logs });
  assert.equal(logins(compit), 1);
  assert.match(message(gladys).fr, /a refusé l’adresse e-mail ou le mot de passe/);
  assert.match(message(gladys).fr, /aucun nouvel essai automatique/);
  await advance(30 * HOUR, MINUTE);
  assert.equal(logins(compit), 1, 'never an automatic retry');
  assert.equal(store.data.refused, true);
  assert.match(store.data.fp, /^[0-9a-f]{32}$/);
  assertNoSecret({ logs, store, gladys });

  // A restart with the same credentials: nothing sent.
  const again = fakeCompit({ password: 'other', registered: true });
  const second = await setup(t, { compit: again, store, create: false });
  assert.equal(again.requests.length, 0);
  assert.match(message(second.gladys).en, /refused the e-mail address or the password/);
});

test('a restart with other credentials than those refused tries again', async (t) => {
  const store = memoryStore();
  const compit = fakeCompit({ password: 'other', registered: true });
  await setup(t, { compit, store });
  assert.equal(store.data.refused, true);
  const good = fakeCompit({ password: 'other', registered: true });
  const second = await setup(t, {
    compit: good,
    store,
    create: false,
    config: { email: EMAIL, password: 'other' },
  });
  assert.equal(logins(good), 0, 'never two sign-ins within a minute, even across a restart');
  assert.match(message(second.gladys).en, /at most one sign-in per minute/);
  await second.advance(MINUTE, 50);
  assert.equal(logins(good), 1);
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.refused, false);
  assert.equal(store.data.fp, '', 'the fingerprint is erased by a success');
});

test('the button tries once after a refusal; only a success lifts the stop', async (t) => {
  const compit = fakeCompit({ password: 'other', registered: true });
  const { gladys, advance, store } = await setup(t, { compit });
  await advance(2 * MINUTE, SECOND);
  let ack = gladys.fake.action(ACTIONS.TEST_CONNECTION);
  await advance(2 * SECOND, 50);
  assert.match((await ack).data.message.en, /refused/);
  assert.equal(logins(compit), 2);
  assert.equal(store.data.refused, true);
  // Within a minute of the last sign-in: no sign-in, the stop holds.
  await advance(20 * SECOND, SECOND);
  ack = gladys.fake.action(ACTIONS.TEST_CONNECTION);
  await advance(2 * SECOND, 50);
  await ack;
  assert.equal(logins(compit), 2);
  assert.equal(store.data.refused, true);
});

test('saving other credentials lifts the stop', async (t) => {
  const compit = fakeCompit({ password: 'new password', registered: true });
  const { gladys, advance, store } = await setup(t, { compit });
  assert.equal(store.data.refused, true);
  await advance(MINUTE, SECOND);
  gladys.fake.configUpdated({ ...CONFIG, language: 'en' });
  await advance(2 * SECOND, 50);
  assert.equal(logins(compit), 1, 'the same credentials keep the stop');
  gladys.fake.configUpdated({ ...CONFIG, password: 'new password' });
  await advance(2 * SECOND, 50);
  assert.equal(logins(compit), 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.refused, false);
});

test('a token refused right after the sign-in is a final stop, not a loop', async (t) => {
  const compit = fakeCompit({ registered: true });
  compit.failNext((r) => r.path === '/gates', { status: 401, times: 5 });
  const { gladys, advance, store } = await setup(t, { compit });
  assert.equal(logins(compit), 1);
  assert.equal(store.data.reason, 'token');
  assert.match(message(gladys).en, /right after the sign-in/);
  await advance(3 * HOUR, MINUTE);
  assert.equal(logins(compit), 1);
});

test('a registration that is not accepted is a final stop, tried once', async (t) => {
  const compit = fakeCompit();
  compit.failNext((r) => r.path === '/clients', { status: 403 });
  const { gladys, advance, store } = await setup(t, { compit });
  assert.equal(compit.requests.filter((r) => r.path === '/clients').length, 1);
  assert.equal(store.data.reason, 'client');
  assert.match(message(gladys).en, /registration of Gladys/);
  await advance(HOUR, MINUTE);
  assert.equal(compit.requests.length, 2);
});

test('a second 422 after the registration is a stop, never a loop', async (t) => {
  const compit = fakeCompit();
  compit.failNext((r) => r.path === '/authorize', {
    status: 422,
    body: { token: 'registration-token' },
    times: 2,
  });
  const { store } = await setup(t, { compit });
  assert.equal(logins(compit), 2);
  assert.equal(store.data.reason, 'client');
});

test('HTTP 429 pauses every path, persisted, and a reconnection keeps the pause', async (t) => {
  const compit = fakeCompit({ registered: true });
  const { gladys, advance, store, app } = await setup(t, { compit });
  compit.failNext((r) => r.path === '/gates' || r.path.endsWith('/state'), {
    status: 429,
    headers: { 'retry-after': '600' },
  });
  // Scan: the gates are read at the next poll.
  await app.scan();
  await advance(2 * MINUTE, SECOND);
  assert.ok(store.data.pausedUntil > Date.now() + 8 * MINUTE);
  assert.match(message(gladys).en, /paused/);
  const count = compit.requests.length;
  await app.connected(CONFIG);
  await advance(5 * MINUTE, SECOND);
  assert.equal(compit.requests.length, count, 'nothing during the pause');
  await advance(6 * MINUTE, SECOND);
  assert.ok(compit.requests.length > count);
});

test('a device refused (403) while the gates read: only it, no new sign-in, spaced', async (t) => {
  const compit = fakeCompit({ registered: true });
  const { gladys, advance } = await setup(t, { compit });
  compit.failNext((r) => r.path === `/devices/${BOILER}/state`, { status: 403, times: 100 });
  await advance(POLL, SECOND);
  assert.equal(logins(compit), 1);
  assert.equal(last(gladys, BOILER, 'status'), 'Accès à cet appareil refusé');
  assert.equal(last(gladys, THERMOSTAT, 'status'), 'OK');
  assert.match(message(gladys).en, /Access refused to 1 device/);
  const tries = () => compit.requests.filter((r) => r.path === `/devices/${BOILER}/state`).length;
  const before = tries();
  await advance(14 * MINUTE, MINUTE);
  assert.equal(tries(), before, 'not read again before 15 min');
});

test('an unreachable iNext backs off, never sooner than the interval', async (t) => {
  const compit = fakeCompit({ registered: true });
  const { advance, gladys } = await setup(t, { compit });
  compit.failNext(() => true, { drop: true, times: 3 });
  await advance(2 * MINUTE, SECOND);
  assert.match(message(gladys).en, /unreachable/);
  const count = compit.requests.length;
  await advance(MINUTE + 50 * SECOND, SECOND);
  assert.equal(compit.requests.length, count);
});

test('a controller silent for over 30 min: values kept, status says so, commands refused', async (t) => {
  const compit = fakeCompit({ registered: true });
  compit.states[THERMOSTAT].last_connected_at = new Date(NOW - 2 * HOUR).toISOString();
  const { gladys, command } = await setup(t, { compit, config: SETPOINTS });
  assert.match(last(gladys, THERMOSTAT, 'status'), /plus de 30 min/);
  assert.equal(last(gladys, THERMOSTAT, 'setpoint'), undefined, 'no stale value published');
  refused(await command(THERMOSTAT, 'setpoint', 21), /30 min/);
  assert.equal(compit.writes().length, 0);
});

test('room setpoint: off by default, bounded, decided on a fresh read, then confirmed', async (t) => {
  const logs = [];
  const compit = fakeCompit({ registered: true });
  const off = await setup(t, { compit, logs });
  refused(await off.command(THERMOSTAT, 'setpoint', 21), /désactivées/);
  assert.equal(compit.writes().length, 0);
  off.app.stop();

  const on = await setup(t, { compit, config: SETPOINTS, create: false });
  for (const d of [...on.gladys.fake.discoveredDevices]) {
    await on.gladys.fake.deviceCreated(d);
  }
  for (const bad of [null, '', 'abc', 25, 4, 21.55]) {
    refused(await on.command(THERMOSTAT, 'setpoint', bad), /température|Consigne|pas de 0,1/);
  }
  assert.equal(compit.writes().length, 0);
  const reads = compit.requests.length;
  ok(await on.command(THERMOSTAT, 'setpoint', 21.5));
  const [write] = compit.writes();
  assert.equal(write.path, `/devices/${THERMOSTAT}/params`);
  assert.deepEqual(write.body, { values: [{ code: '__tempzadpracareczna', value: 21.5 }] });
  assert.equal(
    compit.requests[reads].path,
    `/devices/${THERMOSTAT}/state`,
    'a fresh read before the write',
  );
  await on.advance(25 * SECOND, SECOND);
  assert.equal(last(on.gladys, THERMOSTAT, 'setpoint'), 21.5);
  // Already so (the guard lifted by the read): nothing sent.
  ok(await on.command(THERMOSTAT, 'setpoint', 21.5));
  assert.equal(compit.writes().length, 1);
});

test('a parameter the controller says is not writable is never written', async (t) => {
  const compit = fakeCompit({ registered: true });
  compit.states[THERMOSTAT].params.find((p) => p.code === '__tempzadpracareczna').write = false;
  const { command } = await setup(t, { compit, config: SETPOINTS });
  refused(await command(THERMOSTAT, 'setpoint', 21), /ne permet pas d’écrire/);
  assert.equal(compit.writes().length, 0);
});

test('the option turned off during the fresh read: nothing sent', async (t) => {
  const compit = fakeCompit({ registered: true });
  const { gladys, app, advance } = await setup(t, { compit, config: SETPOINTS });
  compit.failNext((r) => r.path === `/devices/${THERMOSTAT}/state`, { delay: 800 });
  const d = gladys.fake.devices.find((x) => x.external_id === device(THERMOSTAT));
  const f = d.features.find((x) => x.external_id === feature(THERMOSTAT, 'setpoint'));
  let ack;
  gladys.fake.setValue(d, f, 22).then((a) => (ack = a));
  await advance(300, 50);
  await app.configUpdated(CONFIG);
  await advance(5 * SECOND, 50);
  refused(ack, /désactivées/);
  assert.equal(compit.writes().length, 0);
});

test('a slow fresh read is refused unsent; a silent write is "sent, without confirmation"', async (t) => {
  const compit = fakeCompit({ registered: true });
  const { command } = await setup(t, { compit, config: SETPOINTS });
  compit.failNext((r) => r.path === `/devices/${THERMOSTAT}/state`, { delay: 3 * SECOND });
  refused(await command(THERMOSTAT, 'setpoint', 22, { wait: 6 * SECOND }), /trop lentement/);
  assert.equal(compit.writes().length, 0);
  compit.failNext((r) => r.method === 'PUT', { hang: true });
  refused(await command(THERMOSTAT, 'setpoint', 22.5, { wait: 6 * SECOND }), /sans confirmation/);
  assert.equal(compit.writes().at(-1).body.values[0].value, 22.5);
});

test('a refused write is "refused", a 5xx write "sent, without confirmation"', async (t) => {
  const compit = fakeCompit({ registered: true });
  const { command, advance } = await setup(t, { compit, config: SETPOINTS });
  compit.failNext((r) => r.method === 'PUT', { status: 400 });
  refused(await command(THERMOSTAT, 'setpoint', 22), /a refusé la commande/);
  await advance(4 * SECOND, SECOND);
  compit.failNext((r) => r.method === 'PUT', { status: 502 });
  refused(await command(THERMOSTAT, 'setpoint', 22), /sans confirmation/);
});

test('no sign-in inside a command: a refused token gives "try again", the poll renews it', async (t) => {
  const compit = fakeCompit({ registered: true });
  const { command, advance } = await setup(t, { compit, config: SETPOINTS });
  await advance(90 * SECOND, SECOND);
  compit.revokeTokens();
  refused(await command(THERMOSTAT, 'setpoint', 22), /réessayez dans une minute/);
  assert.equal(logins(compit), 1);
  assert.equal(compit.writes().length, 0);
  await advance(2 * MINUTE, SECOND);
  assert.equal(logins(compit), 2);
  ok(await command(THERMOSTAT, 'setpoint', 22));
});

test('hot water: off by default, 55 °C by default, never above 60 °C, within the controller', async (t) => {
  const compit = fakeCompit({ registered: true });
  const off = await setup(t, { compit });
  refused(await off.command(BOILER, 'dhw-setpoint', 50), /eau chaude sont désactivées/);
  off.app.stop();
  const on = await setup(t, { compit, config: DHW, create: false });
  for (const d of [...on.gladys.fake.discoveredDevices]) {
    await on.gladys.fake.deviceCreated(d);
  }
  refused(await on.command(BOILER, 'dhw-setpoint', 56), /de 20 à 55 °C/);
  refused(await on.command(BOILER, 'dhw-setpoint', 30), /de 35 à 55 °C/, 'the controller min');
  ok(await on.command(BOILER, 'dhw-setpoint', 52));
  assert.deepEqual(compit.writes()[0].body, { values: [{ code: '__tzadcwu', value: 52 }] });
  on.app.stop();
  const high = await setup(t, {
    compit,
    config: { ...DHW, max_dhw: 75 },
    create: false,
  });
  for (const d of [...high.gladys.fake.discoveredDevices]) {
    await high.gladys.fake.deviceCreated(d);
  }
  refused(await high.command(BOILER, 'dhw-setpoint', 61), /de 20 à 60 °C/);
  assert.equal(compit.writes().length, 1);
});

test('season: "Winter" behind the option, "Cooling" refused, "Summer" always allowed', async (t) => {
  const compit = fakeCompit({ registered: true });
  const { command, advance, gladys } = await setup(t, { compit });
  refused(await command(THERMOSTAT, 'season', 'winter'), /saison sont désactivés/);
  refused(await command(THERMOSTAT, 'season', 'bogus'), /Saison inconnue/);
  ok(await command(THERMOSTAT, 'season', 'summer'));
  assert.deepEqual(compit.writes()[0].body, {
    values: [{ code: '__trybpracyinstalacji', value: 1 }],
  });
  await advance(25 * SECOND, SECOND);
  assert.equal(last(gladys, THERMOSTAT, 'season'), 'summer');
  // Written again even when it already is (no decision on a stale read).
  ok(await command(THERMOSTAT, 'season', 'summer'));
  assert.equal(compit.writes().length, 2);
});

test('"Summer" goes through a 429 pause (one try) and other commands do not', async (t) => {
  const compit = fakeCompit({ registered: true });
  const { command, advance, app, store } = await setup(t, {
    compit,
    config: { ...SEASONS, allow_setpoints: true },
  });
  compit.failNext((r) => r.path === '/gates' || r.path.endsWith('/state'), { status: 503 });
  await app.scan();
  await advance(2 * MINUTE, SECOND);
  assert.ok(store.data.pausedUntil > Date.now());
  refused(await command(THERMOSTAT, 'setpoint', 22), /en pause/);
  ok(await command(THERMOSTAT, 'season', 'summer'));
  assert.equal(compit.writes().length, 1);
});

test('"Summer" cancels a "Winter" not sent yet and waits only for a write leaving', async (t) => {
  const compit = fakeCompit({ registered: true });
  compit.set(THERMOSTAT, '__trybpracyinstalacji', 1);
  const { gladys, advance } = await setup(t, { compit, config: SEASONS });
  compit.failNext((r) => r.path === `/devices/${THERMOSTAT}/state`, { delay: 1500 });
  const d = gladys.fake.devices.find((x) => x.external_id === device(THERMOSTAT));
  const f = d.features.find((x) => x.external_id === feature(THERMOSTAT, 'season'));
  let winter;
  let summer;
  gladys.fake.setValue(d, f, 'winter').then((a) => (winter = a));
  await advance(200, 50);
  gladys.fake.setValue(d, f, 'summer').then((a) => (summer = a));
  await advance(5 * SECOND, 50);
  ok(summer);
  refused(winter, /Été.*entre-temps/);
  assert.deepEqual(
    compit.writes().map((w) => w.body.values[0].value),
    [1],
  );
});

test('"Summer" after a "Winter" that left: sticky, written again when a read shows otherwise', async (t) => {
  const compit = fakeCompit({ registered: true });
  compit.set(THERMOSTAT, '__trybpracyinstalacji', 1);
  const store = memoryStore();
  const { command, advance } = await setup(t, { compit, config: SEASONS, store });
  ok(await command(THERMOSTAT, 'season', 'winter', { wait: SECOND }));
  ok(await command(THERMOSTAT, 'season', 'summer', { wait: SECOND }));
  assert.equal(store.data.stops.length, 1, 'the sticky guard is kept in /data');
  // The late "Winter" lands after the "Summer" at the controller.
  compit.set(THERMOSTAT, '__trybpracyinstalacji', 0);
  await advance(25 * SECOND, SECOND);
  const values = compit.writes().map((w) => w.body.values[0].value);
  assert.deepEqual(values.slice(0, 3), [0, 1, 1]);
  assert.equal(compit.value(THERMOSTAT, '__trybpracyinstalacji'), 1);
  // Never more than 3 times again.
  for (let i = 0; i < 6; i += 1) {
    compit.set(THERMOSTAT, '__trybpracyinstalacji', 0);
    await advance(20 * SECOND, SECOND);
  }
  assert.ok(compit.writes().length <= 2 + 3);
});

test('read-only features refuse commands; one command at a time per device', async (t) => {
  const compit = fakeCompit({ registered: true });
  const { command, gladys, advance } = await setup(t, {
    compit,
    config: { ...SETPOINTS, allow_dhw: true },
  });
  refused(await command(THERMOSTAT, 'room-temperature', 20), /lecture seule/);
  refused(await command(THERMOSTAT, 'alarms', 'x'), /lecture seule/);
  compit.failNext((r) => r.path === `/devices/${THERMOSTAT}/state`, { delay: 1000 });
  const d = gladys.fake.devices.find((x) => x.external_id === device(THERMOSTAT));
  const f = d.features.find((x) => x.external_id === feature(THERMOSTAT, 'setpoint'));
  const acks = [];
  gladys.fake.setValue(d, f, 21).then((a) => acks.push(a));
  await advance(100, 50);
  gladys.fake.setValue(d, f, 22).then((a) => acks.push(a));
  // Another device is not held up.
  const b = gladys.fake.devices.find((x) => x.external_id === device(BOILER));
  const g = b.features.find((x) => x.external_id === feature(BOILER, 'dhw-setpoint'));
  gladys.fake.setValue(b, g, 51).then((a) => acks.push(a));
  await advance(5 * SECOND, 50);
  assert.equal(acks.filter((a) => a.success).length, 2);
  assert.match(JSON.stringify(acks), /autre commande est en cours/);
});

test('a republished device never loses a feature; a reconnection republishes', async (t) => {
  const compit = fakeCompit({ registered: true });
  const { gladys, app, advance } = await setup(t, { compit });
  compit.states[THERMOSTAT].params = compit.states[THERMOSTAT].params.filter(
    (p) => p.code !== '__rd_tempzewn',
  );
  await app.scan();
  await advance(POLL, SECOND);
  const thermostat = gladys.fake.discoveredDevices.find(
    (d) => d.external_id === device(THERMOSTAT),
  );
  assert.ok(roles(thermostat).includes('outdoor-temperature'));
  // The device leaves the account: shown gone, never removed.
  compit.gates[0].devices = compit.gates[0].devices.filter((d) => d.id !== MIXER);
  await app.scan();
  await advance(POLL, SECOND);
  assert.equal(last(gladys, MIXER, 'status'), 'Appareil introuvable sur le compte');
  const published = gladys.fake.discoveredDevices.length;
  gladys.fake.discoveredDevices.length = 0;
  await app.connected(CONFIG);
  assert.equal(gladys.fake.discoveredDevices.length, published);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a sticky "Summer" kept in /data goes on after a restart', async (t) => {
  const compit = fakeCompit({ registered: true });
  const store = memoryStore({ stops: [{ id: THERMOSTAT, until: NOW + MINUTE }] });
  const { advance } = await setup(t, { compit, store });
  await advance(10 * SECOND, SECOND);
  assert.deepEqual(compit.writes()[0]?.body, {
    values: [{ code: '__trybpracyinstalacji', value: 1 }],
  });
  await advance(3 * MINUTE, SECOND);
  assert.equal(store.data.stops.length, 0, 'lifted by time');
});
