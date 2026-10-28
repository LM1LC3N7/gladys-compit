// -----------------------------------------------------------------------------
// The pure parts: the answers of iNext (untrusted), the catalog, the
// configuration and what /data keeps.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARAMETERS, modelOf, parameterOf, rolesOfType } from '../src/catalog.js';
import { normalizeConfig } from '../src/config.js';
import { FEATURES, LIMITS, TIMINGS } from '../src/constants.js';
import { parseJson } from '../src/compit/client.js';
import { definitionOf, deviceStates, parseFeatureId, ROLES } from '../src/devices.js';
import {
  alarmsOf,
  cleanText,
  gatesOf,
  isStale,
  numberOf,
  seasonOf,
  stateOf,
} from '../src/model.js';
import {
  fingerprint,
  newUid,
  normalizeMemory,
  refusalPrint,
  serializeMemory,
} from '../src/store.js';

test('gates: shape checked, ids and types integers, bounded, a device kept once', () => {
  const gates = gatesOf({
    gates: [
      {
        id: 1,
        label: ' Dom\u0000 ',
        devices: [
          { id: 10, label: 'Salon', type: 223 },
          { id: 10, label: 'twice', type: 12 },
          { id: '11', label: 'text id', type: 12 },
          { id: 12, label: 'no type' },
          { id: 13, label: 'x'.repeat(500), type: 201 },
        ],
      },
      { id: -1, devices: [] },
      { id: 2, devices: 'nope' },
    ],
  });
  assert.equal(gates.length, 1);
  assert.equal(gates[0].label, 'Dom');
  assert.deepEqual(
    gates[0].devices.map((d) => d.id),
    [10, 13],
  );
  assert.equal(gates[0].devices[1].label.length, LIMITS.nameLength);
  assert.equal(gatesOf({}), undefined);
  assert.equal(gatesOf(null), undefined);
  const many = gatesOf({
    gates: [{ id: 1, devices: Array.from({ length: 100 }, (_, i) => ({ id: i, type: 7 })) }],
  });
  assert.equal(many[0].devices.length, LIMITS.devices);
});

test('state: own keys only, strict numbers, write must be true, errors as short texts', () => {
  const data = parseJson(
    JSON.stringify({
      errors: ['E1', { label: 'E2 sensor' }, { code: 7 }, {}, null],
      last_connected_at: '2026-10-24T17:59:00Z',
      params: [
        { code: '__a', value: 21.5, write: true, min: 5, max: 30 },
        { code: '__b', value: '', write: 'true' },
        { code: '__c', value: '22.5' },
        { code: '__d', value: 'abc' },
        { code: 'bad code!', value: 1 },
        { code: '__a', value: 99 },
        { code: '__proto__', value: 1 },
      ],
      __proto__: { polluted: true },
    }),
  );
  const state = stateOf(data);
  assert.equal({}.polluted, undefined);
  assert.deepEqual([...state.params.keys()], ['__a', '__b', '__c', '__d']);
  assert.deepEqual(state.params.get('__a'), { value: 21.5, min: 5, max: 30, write: true });
  assert.equal(state.params.get('__b').value, undefined, "'' is not 0");
  assert.equal(state.params.get('__b').write, false, "only true writes, not 'true'");
  assert.equal(state.params.get('__c').value, 22.5);
  assert.equal(state.params.get('__d').value, undefined);
  assert.deepEqual(state.errors, ['E1', 'E2 sensor', '7', '?']);
  assert.equal(state.lastContact, Date.UTC(2026, 9, 24, 17, 59));
  assert.equal(stateOf({ params: 'x' }), undefined);
  assert.equal(numberOf(null), undefined);
  assert.equal(numberOf(Infinity), undefined);
});

test('alarms: none, the list, an AF-1 code; unknown when the answer says nothing', () => {
  assert.deepEqual(alarmsOf(stateOf({ errors: [], params: [] }), 223), []);
  assert.equal(alarmsOf(stateOf({ params: [] }), 223), undefined);
  assert.deepEqual(
    alarmsOf(stateOf({ errors: [], params: [{ code: '__kod_alarmu', value: 4 }] }), 226),
    ['#4'],
  );
  const ids = { feature: (role) => `x:${role}` };
  const long = stateOf({ errors: Array.from({ length: 8 }, (_, i) => `E${i}`), params: [] });
  const text = deviceStates(ids, { type: 223, state: long, language: 'en' }).find(
    (s) => s.device_feature_external_id === 'x:alarms',
  ).text;
  assert.equal(text, 'E0; E1; E2; E3; E4; +3');
});

test('stale: compared with the time of the server only, never "stale" without it', () => {
  const state = stateOf({ params: [], last_connected_at: '2026-10-24T17:00:00Z' });
  const server = Date.UTC(2026, 9, 24, 18, 0);
  assert.equal(isStale(state, server), true);
  assert.equal(isStale(state, Date.UTC(2026, 9, 24, 17, 20)), false);
  assert.equal(isStale(state, undefined), false);
  assert.equal(isStale(stateOf({ params: [], last_connected_at: 'garbage' }), server), false);
  assert.equal(TIMINGS.staleAfter, 30 * 60_000);
});

test('season values; text cleaning', () => {
  assert.equal(seasonOf(0), 'winter');
  assert.equal(seasonOf(1), 'summer');
  assert.equal(seasonOf(2), 'cooling');
  assert.equal(seasonOf(3), undefined);
  assert.equal(cleanText('a\u202eb\nc'), 'a b c');
  assert.equal(cleanText({}), '');
});

test('the catalog: every role has a definition, codes are safe, the thermostats complete', () => {
  for (const [role, table] of Object.entries(PARAMETERS)) {
    assert.ok(ROLES.includes(role), role);
    definitionOf(role);
    for (const code of Object.values(table)) {
      assert.match(code, /^[A-Za-z0-9_]{1,64}$/);
    }
  }
  for (const type of [12, 223]) {
    assert.deepEqual(rolesOfType(type), [
      FEATURES.ROOM_TEMPERATURE,
      FEATURES.ROOM_TARGET,
      FEATURES.SETPOINT,
      FEATURES.OUTDOOR,
      FEATURES.SEASON,
    ]);
  }
  assert.equal(parameterOf(FEATURES.SEASON, 224), undefined, 'R 900: values not documented');
  assert.equal(parameterOf(FEATURES.SETPOINT, 7), undefined, 'Nano One: read only (R)');
  assert.equal(parameterOf(FEATURES.ROOM_TARGET, 7), '__tzadman');
  assert.equal(parameterOf('__proto__', 1), undefined);
  assert.equal(parameterOf(FEATURES.SETPOINT, 'constructor'), undefined);
  assert.equal(modelOf(223), 'Compit Nano Color 2');
  assert.equal(modelOf(999), 'Compit (type 999)');
});

test('feature ids: our shape and roles only', () => {
  assert.deepEqual(parseFeatureId('ext:x:compit:501:setpoint'), {
    deviceId: 501,
    role: 'setpoint',
  });
  assert.equal(parseFeatureId('ext:x:compit:501:nope'), undefined);
  assert.equal(parseFeatureId('ext:x:compit:abc:setpoint'), undefined);
  assert.equal(parseFeatureId(42), undefined);
});

test('configuration: commands off unless true, ceilings bounded whatever is typed', () => {
  const c = normalizeConfig({ email: 'a@b.c', password: 'p' });
  assert.equal(c.problem, undefined);
  assert.deepEqual([c.allowSetpoints, c.allowDhw, c.allowSeasons], [false, false, false]);
  assert.deepEqual([c.roomCeiling, c.dhwCeiling], [24, 65]);
  const high = normalizeConfig({ max_setpoint: 99, max_dhw: 95, allow_dhw: 'yes' });
  assert.deepEqual([high.roomCeiling, high.dhwCeiling, high.allowDhw], [30, 65, false]);
  assert.equal(normalizeConfig({ max_dhw: 65 }).dhwCeiling, 65);
  assert.equal(normalizeConfig({ max_dhw: 65.5 }).dhwCeiling, 65);
  const low = normalizeConfig({ max_setpoint: '', max_dhw: 10 });
  assert.deepEqual([low.roomCeiling, low.dhwCeiling], [24, 40]);
  assert.equal(normalizeConfig({ email: 'bad', password: 'p' }).problem, 'badEmail');
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 60);
});

test('/data: never a secret, bounded on reload, the fingerprint only while refused', () => {
  const now = Date.UTC(2026, 9, 24);
  const memory = normalizeMemory(
    {
      pausedUntil: now + 100 * 3600_000,
      lastLoginAt: now + 3600_000,
      refused: true,
      fp: 'f'.repeat(32),
      reason: 'evil',
      stops: [
        { id: 501, until: now + 3600_000 },
        { id: 'x', until: now + 1000 },
      ],
      password: 'leak',
    },
    now,
  );
  assert.equal(memory.pausedUntil, now + TIMINGS.pauseMax);
  assert.equal(memory.lastLoginAt, now);
  assert.equal(memory.reason, 'login');
  assert.deepEqual(memory.stops, [{ id: 501, until: now + TIMINGS.guard }]);
  const saved = JSON.stringify(serializeMemory(memory));
  assert.ok(!saved.includes('leak'));
  const lifted = serializeMemory({ ...memory, refused: false });
  assert.equal(lifted.fp, '');
  const fp = fingerprint(memory.salt, 'jan@example.com\nsecret');
  assert.match(fp, /^[0-9a-f]{32}$/);
  assert.notEqual(fp, fingerprint(normalizeMemory(null, now).salt, 'jan@example.com\nsecret'));
});

test('/data: the uid of the installation, the last read, the print of a refusal', () => {
  const now = Date.UTC(2026, 9, 24);
  const uid = newUid();
  assert.match(uid, /^gladys-compit-[0-9a-f]{16}$/);
  const memory = normalizeMemory({ uid, lastReadAt: now + 5000 }, now);
  assert.equal(memory.uid, uid);
  assert.equal(memory.lastReadAt, now, 'a time ahead of the clock counts as now');
  assert.equal(normalizeMemory({ uid: 'HomeAssistant' }, now).uid, '');
  const salt = memory.salt;
  assert.equal(refusalPrint(salt, 'login', 'a@b.c', 'pw'), fingerprint(salt, 'a@b.c\npw'));
  for (const reason of ['token', 'client', 'request']) {
    assert.equal(refusalPrint(salt, reason, 'a@b.c', 'pw'), fingerprint(salt, 'a@b.c\n'));
  }
  assert.deepEqual(Object.keys(serializeMemory(memory)).sort(), [
    'fp',
    'lastLoginAt',
    'lastReadAt',
    'pausedUntil',
    'reason',
    'refused',
    'salt',
    'stops',
    'uid',
  ]);
});
