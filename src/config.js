// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The password is
// kept here and in the client only: never logged, never in /data, never in a
// status or an error. The e-mail address is never logged either.
// -----------------------------------------------------------------------------

import { DHW, POLL_INTERVAL, SETPOINT } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  email: '',
  allow_setpoints: false,
  allow_dhw: false,
  allow_seasons: false,
  max_setpoint: SETPOINT.ceilingDefault,
  max_dhw: DHW.ceilingDefault,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** A ceiling: whole degrees within [low, high], else the default. Never above `high`. */
function ceiling(value, { ceilingMin, max, ceilingDefault }) {
  const number = numberOf(value);
  if (number === undefined) {
    return ceilingDefault;
  }
  return Math.min(max, Math.max(ceilingMin, Math.floor(number)));
}

export const roomCeilingOf = (value) => ceiling(value, SETPOINT);
export const dhwCeilingOf = (value) => ceiling(value, DHW);

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, password: '' };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const email = typeof c.email === 'string' ? c.email.trim() : '';
  const password = typeof c.password === 'string' ? c.password : '';
  let problem;
  if (email === '' && password === '') {
    problem = 'empty';
  } else if (email === '') {
    problem = 'noEmail';
  } else if (!EMAIL.test(email)) {
    problem = 'badEmail';
  } else if (password === '') {
    problem = 'noPassword';
  } else if (password.length > 256) {
    problem = 'badPassword';
  }
  const interval = numberOf(c.poll_interval);
  return {
    /** Why the configuration cannot be used (shown in the status), else undefined. */
    problem,
    email: problem ? '' : email,
    password: problem ? '' : password,
    allowSetpoints: strictTrue(c.allow_setpoints),
    allowDhw: strictTrue(c.allow_dhw),
    allowSeasons: strictTrue(c.allow_seasons),
    roomCeiling: roomCeilingOf(c.max_setpoint),
    dhwCeiling: dhwCeilingOf(c.max_dhw),
    pollInterval:
      interval === undefined
        ? POLL_INTERVAL.default
        : Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval))),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What a restart depends on: the account (compared in memory only, never stored). */
export const connectionKey = (config) =>
  JSON.stringify([config.problem ?? null, config.email, config.password]);

/** The secret whose refusal is remembered (as a salted fingerprint only). */
export const accountSecret = (config) => `${config.email}\n${config.password}`;
