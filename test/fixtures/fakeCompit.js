// -----------------------------------------------------------------------------
// A fake Compit iNext API behind the injected HTTPS transport: the sign-in
// (with the registration of the client on its first sign-in), the gates,
// the device states and the writes, with the shapes compit-inext-api reads
// (types/SystemInfo.py, types/DeviceState.py). Its timers are those of the
// test (mocked); `failNext` makes the next matching requests fail.
// -----------------------------------------------------------------------------

import { CODES, CompitError } from '../../src/compit/errors.js';

export const NOW = Date.UTC(2026, 9, 24, 18, 0, 0);
export const EMAIL = 'jan@example.com';
export const PASSWORD = 'correct horse';
export const THERMOSTAT = 501; // Nano Color 2 (type 223)
export const BOILER = 502; // BioMax775 (type 201)
export const MIXER = 503; // R350.M (type 221)
const REGISTRATION = 'registration-token';

export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const param = (code, value, { write = false, min = null, max = null, label = null } = {}) => ({
  code,
  hidden: false,
  max,
  min,
  value,
  value_code: null,
  value_label: label,
  write,
  ext_info: null,
});

export function states(now = NOW) {
  const contact = new Date(now - 60_000).toISOString();
  return {
    [THERMOSTAT]: {
      errors: [],
      last_connected_at: contact,
      params: [
        param('__tpokojowa', 21.4),
        param('__tpokzadana', 21),
        param('__tempzadpracareczna', 20, { write: true, min: 0, max: 40 }),
        param('__rd_tempzewn', 8.5),
        param('__trybpracyinstalacji', 0, { write: true, label: 'Winter' }),
        param('__rd_co2', 1),
      ],
    },
    [BOILER]: {
      errors: [{ label: 'E12 Czujnik CWU' }],
      last_connected_at: contact,
      params: [
        param('__t_boiler', 62.5),
        param('__t_cwu', 48.2),
        param('__tzadcwu', 50, { write: true, min: 35, max: 70 }),
        param('__Tzew', 8.4),
        param('__fuel', 75),
      ],
    },
    [MIXER]: {
      errors: [],
      last_connected_at: contact,
      params: [param('__rr_t_mie', 38.2), param('__rt_t_zew', 8.3)],
    },
  };
}

export function gates() {
  return [
    {
      code: 'GATE1',
      id: 100,
      label: 'Dom',
      devices: [
        { class: 10, id: THERMOSTAT, label: 'Salon', type: 223 },
        { class: 15, id: BOILER, label: 'Kocioł', type: 201 },
        { class: 14, id: MIXER, label: 'Mieszacz', type: 221 },
      ],
    },
  ];
}

export function fakeCompit({ email = EMAIL, password = PASSWORD, registered = false } = {}) {
  const compit = {
    requests: [],
    tokens: new Set(),
    issued: 0,
    registered,
    gates: gates(),
    states: states(),
    /** [{ match: (req) => bool, status, delay, hang, drop, times }] */
    failures: [],
    delay: 50,
    failNext(match, outcome) {
      compit.failures.push({ times: 1, ...outcome, match });
    },
    revokeTokens() {
      compit.tokens.clear();
    },
    value(deviceId, code) {
      return compit.states[deviceId].params.find((p) => p.code === code)?.value;
    },
    set(deviceId, code, value) {
      compit.states[deviceId].params.find((p) => p.code === code).value = value;
    },
    writes() {
      return compit.requests.filter((r) => r.method === 'PUT');
    },
    request: (options) => handle(compit, { email, password }, options),
  };
  return compit;
}

function answer(status, body, headers = {}) {
  return {
    status,
    headers: { date: new Date(Date.now()).toUTCString(), ...headers },
    body: body === undefined ? '' : JSON.stringify(body),
  };
}

function handle(
  compit,
  account,
  { method, url, headers = {}, body, timeout, sendWithin, beforeSend },
) {
  const path = url.replace('https://inext.compit.pl/mobile/v2/compit', '');
  return new Promise((resolve, reject) => {
    const failure = compit.failures.find((f) => f.match({ method, path }));
    if (failure) {
      failure.times -= 1;
      if (failure.times <= 0) {
        compit.failures.splice(compit.failures.indexOf(failure), 1);
      }
    }
    const connectDelay = failure?.connectDelay ?? 0;
    let sent = false;
    const timer = setTimeout(() => reject(new CompitError(CODES.TIMEOUT, { sent })), timeout);
    if (sendWithin !== undefined && connectDelay > sendWithin) {
      clearTimeout(timer);
      setTimeout(() => reject(new CompitError(CODES.LATE)), Math.max(0, sendWithin));
      return;
    }
    setTimeout(() => {
      if (beforeSend) {
        try {
          beforeSend();
        } catch (err) {
          clearTimeout(timer);
          err.beforeSend = true;
          err.sent = false;
          reject(err);
          return;
        }
      }
      sent = true;
      const parsed = body === undefined ? undefined : JSON.parse(body);
      const request = { method, path, auth: headers.authorization, body: parsed, headers };
      compit.requests.push(request);
      if (failure?.hang) {
        return;
      }
      setTimeout(() => {
        clearTimeout(timer);
        if (failure?.drop) {
          reject(new CompitError(CODES.UNREACHABLE, { sent: true }));
          return;
        }
        if (failure?.status) {
          resolve(answer(failure.status, failure.body ?? { error: 'x' }, failure.headers));
          return;
        }
        resolve(route(compit, account, request));
      }, failure?.delay ?? compit.delay);
    }, connectDelay);
  });
}

function route(compit, account, { method, path, auth, body }) {
  if (method === 'POST' && path === '/authorize') {
    if (body?.email !== account.email || body?.password !== account.password) {
      return answer(401, { message: 'Unauthorized' });
    }
    if (!compit.registered) {
      return answer(422, { token: REGISTRATION });
    }
    compit.issued += 1;
    const token = `token-${compit.issued}`;
    compit.tokens.add(token);
    return answer(200, { token, gates: compit.gates });
  }
  if (method === 'POST' && path === '/clients') {
    if (auth !== REGISTRATION) {
      return answer(401, { message: 'Unauthorized' });
    }
    compit.registered = true;
    return answer(200, {});
  }
  if (!auth || !compit.tokens.has(auth)) {
    return answer(401, { message: 'Unauthorized' });
  }
  if (method === 'GET' && path === '/gates') {
    return answer(200, { gates: compit.gates });
  }
  const match = /^\/devices\/(\d+)\/(state|params)$/.exec(path);
  const state = match ? compit.states[match[1]] : undefined;
  if (!state) {
    return answer(404, { message: 'Not found' });
  }
  if (method === 'GET' && match[2] === 'state') {
    return answer(200, state);
  }
  if (method === 'PUT' && match[2] === 'params') {
    for (const { code, value } of body.values) {
      const entry = state.params.find((p) => p.code === code);
      if (!entry || !entry.write) {
        return answer(400, { message: 'Bad parameter' });
      }
      entry.value = value;
    }
    return answer(200, { status: 'ok' });
  }
  return answer(404, { message: 'Not found' });
}
