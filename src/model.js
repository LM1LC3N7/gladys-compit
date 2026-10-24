// -----------------------------------------------------------------------------
// The answers of the iNext API, checked and reduced to what the integration
// uses (pure). Ported from compit-inext-api 0.9.2 (Apache-2.0, Przemko92):
// `types/SystemInfo.py` (the gates and their devices) and
// `types/DeviceState.py` (the parameters of a device, its errors, its last
// contact). Every answer is untrusted: bounded lists, own keys only, values
// of the expected type or left out (never a guess: an empty text is not 0).
// -----------------------------------------------------------------------------

import { LIMITS, SEASONS, TIMINGS } from './constants.js';
import { ALARM_CODE } from './catalog.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

const isId = (value) => Number.isSafeInteger(value) && value >= 0 && value < 1e12;

/** A name for Gladys: no control or invisible formatting characters, trimmed, cut. */
export function cleanText(value, length = LIMITS.nameLength) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return '';
  }
  return (
    String(value)
      .slice(0, 4 * length)
      // eslint-disable-next-line no-control-regex -- control characters are what this removes
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, length)
      .trim()
  );
}

/** A number of the API: a finite number, or a plain decimal text; else undefined. */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,7}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The gates of `GET /gates` (or of `/authorize`): [{ id, label, devices:
 * [{ id, label, type, gateId }] }], at most LIMITS.gates gates and
 * LIMITS.devices devices in all (a device id seen twice is kept once).
 * undefined when the answer does not have this shape.
 */
export function gatesOf(data) {
  const list = own(data, 'gates');
  if (!Array.isArray(list)) {
    return undefined;
  }
  const seen = new Set();
  const gates = [];
  for (const raw of list.slice(0, LIMITS.gates)) {
    const id = own(raw, 'id');
    const devices = own(raw, 'devices');
    if (!isId(id) || !Array.isArray(devices)) {
      continue;
    }
    const gate = { id, label: cleanText(own(raw, 'label')) || `iNext ${id}`, devices: [] };
    for (const d of devices.slice(0, LIMITS.devices)) {
      const deviceId = own(d, 'id');
      const type = own(d, 'type');
      if (!isId(deviceId) || !Number.isSafeInteger(type) || type < 0 || seen.has(deviceId)) {
        continue;
      }
      if (seen.size >= LIMITS.devices) {
        break;
      }
      seen.add(deviceId);
      gate.devices.push({
        id: deviceId,
        label: cleanText(own(d, 'label')),
        type,
        gateId: id,
      });
    }
    gates.push(gate);
  }
  return gates;
}

/** The devices of the gates, by id. */
export function devicesOf(gates) {
  const map = new Map();
  for (const gate of gates ?? []) {
    for (const device of gate.devices) {
      map.set(device.id, { ...device, gateLabel: gate.label });
    }
  }
  return map;
}

const CODE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * The state of `GET /devices/{id}/state`: { params: Map(code -> { value,
 * min, max, write }), errors: [text], lastContact } or undefined when the
 * answer does not have this shape. `value` is a number or undefined.
 */
export function stateOf(data) {
  const list = own(data, 'params');
  if (!Array.isArray(list)) {
    return undefined;
  }
  const params = new Map();
  for (const p of list.slice(0, LIMITS.params)) {
    const code = own(p, 'code');
    if (typeof code !== 'string' || !CODE.test(code) || code === '__proto__' || params.has(code)) {
      continue;
    }
    params.set(code, {
      value: numberOf(own(p, 'value')),
      min: numberOf(own(p, 'min')),
      max: numberOf(own(p, 'max')),
      write: own(p, 'write') === true,
    });
  }
  const rawErrors = own(data, 'errors');
  const errors = Array.isArray(rawErrors)
    ? rawErrors.slice(0, LIMITS.errors).map(errorText).filter(Boolean)
    : [];
  const contact = own(data, 'last_connected_at');
  const lastContact =
    typeof contact === 'string' && contact.length <= 64 ? Date.parse(contact) : NaN;
  return {
    params,
    errors,
    errorsKnown: Array.isArray(rawErrors),
    lastContact: Number.isFinite(lastContact) ? lastContact : undefined,
  };
}

const ERROR_KEYS = ['label', 'description', 'message', 'name', 'code', 'id'];

/** One error of a state answer, as a short text (its shape is not documented). */
function errorText(entry) {
  if (typeof entry === 'string' || typeof entry === 'number') {
    return cleanText(entry);
  }
  for (const key of ERROR_KEYS) {
    const text = cleanText(own(entry, key));
    if (text) {
      return text;
    }
  }
  return entry === null || entry === undefined ? '' : '?';
}

/** The number of a parameter, else undefined. */
export function valueOf(state, code) {
  return code === undefined ? undefined : state?.params.get(code)?.value;
}

/** The season option of a raw value (0, 1, 2), else undefined. */
export function seasonOf(value) {
  return Object.keys(SEASONS).find((key) => SEASONS[key] === value);
}

/**
 * The alarms of a device: the texts of `errors`, and the alarm code of an
 * AF-1 when it is not 0. undefined when the answer said nothing of them.
 */
export function alarmsOf(state, type) {
  if (!state) {
    return undefined;
  }
  const list = [...state.errors];
  const code = valueOf(state, Object.hasOwn(ALARM_CODE, type) ? ALARM_CODE[type] : undefined);
  if (code !== undefined && code !== 0) {
    list.push(`#${code}`);
  }
  if (!state.errorsKnown && code === undefined) {
    return undefined;
  }
  return list;
}

/**
 * Whether the controller has not reached the cloud for a while: its last
 * contact compared with the time of the iNext server (the `Date` header),
 * never with the clock of Gladys. Without either time, never stale.
 */
export function isStale(state, serverTime) {
  if (state?.lastContact === undefined || serverTime === undefined) {
    return false;
  }
  return serverTime - state.lastContact > TIMINGS.staleAfter;
}
