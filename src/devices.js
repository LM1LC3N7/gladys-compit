// -----------------------------------------------------------------------------
// The Compit devices of the account -> Gladys devices and states (pure).
//
// `ext:<selector>:compit:<device id>`: one Gladys device per Compit device
// (a thermostat, a boiler, a mixing valve controller...), keyed by the id
// iNext gives it (stable when it is renamed). The feature roles (the last
// part of their external ids) are published forever: never rename them.
//
// A feature appears once its parameter was read with a value; a device
// published again never loses a feature: those of the device already
// created in Gladys are kept as they are (the core would mark it
// `structure_changed`, and "Update" would delete the missing feature and
// its history).
//
// No switch, no writable binary: a "turn everything off" (Google Home,
// Alexa, HomeKit, MCP, `switch.*` scenes) must never reach the heating. The
// commands are the room setpoint (`thermostat/target-temperature`), the hot
// water setpoint (`water-heater/target-temperature`, whole degrees) and the
// season of the installation (`text/select`), refused unless the
// configuration allows them (src/app.js), except "Summer" (no option).
//
// Units are those the core lists (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C on
// `temperature-sensor`, `thermostat` and `water-heater`, % on
// `humidity-sensor` and `level-sensor`.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DHW, FEATURES as F, SEASONS, SETPOINT } from './constants.js';
import { modelOf, parameterOf } from './catalog.js';
import {
  ALARM_TEXTS,
  FEATURE_NAMES,
  SEASON_NAMES,
  STATUS_TEXTS,
  deviceName,
  word,
} from './i18n.js';
import { alarmsOf, seasonOf, valueOf } from './model.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const temperature = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -50,
  max: 250,
});
const target = (bounds, category = C.THERMOSTAT, type = T.THERMOSTAT.TARGET_TEMPERATURE) => ({
  category,
  type,
  unit: U.CELSIUS,
  // The slider stops at the hard bounds; the configured ceiling refuses below them.
  min: bounds.min,
  max: bounds.max,
  read_only: false,
  has_feedback: true,
  keep_history: true,
});

/** Alarms shown in the text (the others counted). */
const MAX_ALARMS = 5;

/** The temperature roles (read only). */
export const TEMPERATURE_ROLES = [
  F.ROOM_TEMPERATURE,
  F.ROOM_TARGET,
  F.OUTDOOR,
  F.BOILER,
  F.DHW_TEMPERATURE,
  F.MIXER,
  F.MIXER2,
  F.BUFFER,
  F.RETURN,
  F.COLLECTOR,
];

/** The features, by role. */
export function definitionOf(role) {
  if (TEMPERATURE_ROLES.includes(role)) {
    return temperature;
  }
  switch (role) {
    case F.SETPOINT:
      return target(SETPOINT);
    case F.DHW_SETPOINT:
      // The core's hot water setpoint (whole degrees), never a room thermostat:
      // "set every thermostat to 21" must not reach the hot water.
      return target(DHW, C.WATER_HEATER, T.WATER_HEATER.TARGET_TEMPERATURE);
    case F.HUMIDITY:
      return sensor({
        category: C.HUMIDITY_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: U.PERCENT,
        min: 0,
        max: 100,
      });
    case F.FUEL:
      return sensor({
        category: C.LEVEL_SENSOR,
        type: T.LEVEL_SENSOR.LIQUID_LEVEL_PERCENT,
        unit: U.PERCENT,
        min: 0,
        max: 100,
      });
    case F.SEASON:
      return {
        category: C.TEXT,
        type: T.TEXT.SELECT,
        min: 0,
        max: 0,
        read_only: false,
        has_feedback: true,
        keep_history: false,
      };
    case F.ALARMS:
    case F.STATUS:
      return text;
    default:
      throw new Error(`unknown role ${role}`);
  }
}

/** Display order. */
export const ROLES = [
  F.ROOM_TEMPERATURE,
  F.ROOM_TARGET,
  F.SETPOINT,
  F.SEASON,
  F.OUTDOOR,
  F.BOILER,
  F.DHW_TEMPERATURE,
  F.DHW_SETPOINT,
  F.MIXER,
  F.MIXER2,
  F.BUFFER,
  F.RETURN,
  F.COLLECTOR,
  F.HUMIDITY,
  F.FUEL,
  F.ALARMS,
  F.STATUS,
];
export const COMMAND_ROLES = [F.SETPOINT, F.DHW_SETPOINT, F.SEASON];

/** The fields of a feature Gladys stores (what is kept of a created feature). */
const DECLARED = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

export const deviceIds = (gladys, deviceId) => gladys.externalIds('compit', String(deviceId));

const KEY = /:compit:(\d{1,12})/;

/** The device and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') {
    return undefined;
  }
  const match = new RegExp(`${KEY.source}:([a-z0-9-]{1,40})$`).exec(externalId);
  if (!match || !ROLES.includes(match[2])) {
    return undefined;
  }
  return { deviceId: Number(match[1]), role: match[2] };
}

/** The device id of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  const match = new RegExp(`${KEY.source}$`).exec(String(externalId ?? ''));
  return match ? Number(match[1]) : undefined;
}

/** The type code kept in the params of a created device (for a command before any read). */
export function typeOfCreated(device) {
  const param = (device?.params ?? []).find((p) => p?.name === 'type');
  const text = typeof param?.value === 'string' ? param.value : String(param?.value ?? '');
  return /^\d{1,6}$/.test(text) ? Number(text) : undefined;
}

/** The roles the values of one read report. */
export function reportedRoles(type, state) {
  const roles = new Set([F.ALARMS, F.STATUS]);
  for (const role of ROLES) {
    const code = parameterOf(role, type);
    if (code === undefined) {
      continue;
    }
    const value = valueOf(state, code);
    if (role === F.SEASON ? seasonOf(value) !== undefined : value !== undefined) {
      roles.add(role);
    }
  }
  return roles;
}

/** The options of the season select. */
export function seasonOptions(language) {
  return Object.keys(SEASONS).map((key, i) => ({
    value: key,
    label: word(SEASON_NAMES[key], language),
    sort_order: i,
  }));
}

/**
 * The Gladys device of a Compit device. `roles`: those seen; `info`: the
 * device of the gate list ({ id, label, type, gateLabel }) or undefined;
 * `created`: the device already created in Gladys, whose features are kept
 * when the new build lacks them.
 */
export function buildDevice(gladys, deviceId, { roles, info, type, language, created }) {
  const ids = deviceIds(gladys, deviceId);
  const params = [];
  if (type !== undefined) {
    params.push({ name: 'type', value: String(type) });
  }
  if (info?.gateLabel) {
    params.push({ name: 'gate', value: info.gateLabel });
  }
  const model = type === undefined ? 'Compit' : modelOf(type);
  const built = {
    name: created?.name ?? word(deviceName(info?.label, model, deviceId), language),
    external_id: ids.device,
    model,
    should_poll: false,
    features: ROLES.filter((role) => roles.has(role)).map((role) => ({
      name: word(FEATURE_NAMES[role], language),
      external_id: ids.feature(role),
      ...definitionOf(role),
      ...(role === F.SEASON ? { supported_options: seasonOptions(language) } : {}),
    })),
    params,
  };
  return keepCreatedFeatures(built, created);
}

/** The features of the created device that the new build lacks, kept as they are. */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => typeof f?.external_id === 'string' && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  // A created device keeps its params too (the type of a command before any read).
  const params = built.params.length > 0 ? built.params : (created.params ?? []);
  return { ...built, features: [...built.features, ...kept], params };
}

/**
 * The current values of a device. `status`: 'online', or 'stale' (the
 * controller has not reached the cloud), 'denied', 'offline' (iNext does
 * not answer), 'gone' (no longer on the account): then only the status text
 * changes, Gladys keeps the last value of the others.
 */
export function deviceStates(ids, { type, state, status = 'online', language }) {
  const statusText = word(STATUS_TEXTS[status] ?? STATUS_TEXTS.unknown, language);
  const states = [{ role: F.STATUS, text: statusText }];
  if (status === 'online' && state) {
    for (const role of ROLES) {
      const code = parameterOf(role, type);
      const value = valueOf(state, code);
      if (value === undefined) {
        continue;
      }
      if (role === F.SEASON) {
        const season = seasonOf(value);
        if (season !== undefined) {
          states.push({ role, text: season });
        }
      } else {
        states.push({ role, state: value });
      }
    }
    const alarms = alarmsOf(state, type);
    if (alarms !== undefined) {
      states.push({
        role: F.ALARMS,
        text: word(
          alarms.length === 0
            ? ALARM_TEXTS.none
            : ALARM_TEXTS.list(
                alarms.length > MAX_ALARMS
                  ? [...alarms.slice(0, MAX_ALARMS), `+${alarms.length - MAX_ALARMS}`]
                  : alarms,
              ),
          language,
        ),
      });
    }
  }
  return states.map(({ role, ...value }) => ({
    device_feature_external_id: ids.feature(role),
    ...value,
  }));
}
