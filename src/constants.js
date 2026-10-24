// -----------------------------------------------------------------------------
// Constants: the Compit iNext API, feature roles, manifest keys, limits and
// timings.
//
// Compit (Poland) makes heating controllers: room thermostats (Nano One,
// Nano Color, Nano Color 2), boiler, mixing valve, hot water, solar and heat
// pump controllers. They are read and set through the cloud of the iNext
// portal (https://inext.compit.pl), with the e-mail address and the password
// of the user's iNext account, as compit-inext-api 0.9.2 (Apache-2.0,
// Przemko92, the library of Home Assistant's Compit integration) uses it:
//   - POST /authorize { email, password, uid, label } -> { token, gates };
//   - POST /clients { fcm_token: null, uid, label }: registers this client
//     on the account when /authorize answers 422 (first sign-in);
//   - GET /gates: the gates (iNext modules) and the devices behind them;
//   - GET /devices/{id}/state: the parameters of one device, and its errors;
//   - PUT /devices/{id}/params { values: [{ code, value }] }: a write.
// The API is not documented publicly. No application key, no app identity:
// the client registers under its own name ("Gladys"), Node sends no
// User-Agent of an app.
// -----------------------------------------------------------------------------

export const COMPIT = {
  apiUrl: 'https://inext.compit.pl/mobile/v2/compit',
  /**
   * The name this client registers under on the account (never an app's
   * name), and the start of its uid: one uid per installation, random,
   * kept in /data (two Gladys on one account never share a client).
   */
  clientUid: 'gladys-compit',
  clientLabel: 'Gladys',
};

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  ROOM_TEMPERATURE: 'room-temperature',
  ROOM_TARGET: 'room-target',
  SETPOINT: 'setpoint',
  OUTDOOR: 'outdoor-temperature',
  BOILER: 'boiler-temperature',
  DHW_TEMPERATURE: 'dhw-temperature',
  DHW_SETPOINT: 'dhw-setpoint',
  MIXER: 'mixer-temperature',
  MIXER2: 'mixer2-temperature',
  BUFFER: 'buffer-temperature',
  RETURN: 'return-temperature',
  COLLECTOR: 'collector-temperature',
  HUMIDITY: 'humidity',
  FUEL: 'fuel-level',
  SEASON: 'season',
  ALARMS: 'alarms',
  STATUS: 'status',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds (Home Assistant: 60 s). */
export const POLL_INTERVAL = {
  min: 60,
  max: 900,
  default: 120,
};

/**
 * Room setpoints Gladys may send, in °C: from 5 °C to the configured ceiling
 * (24 °C by default, 16 to 30 °C, never above 30 °C whatever is typed), and
 * always within the bounds the controller gives for the parameter.
 */
export const SETPOINT = {
  min: 5,
  max: 30,
  ceilingMin: 16,
  ceilingDefault: 24,
};

/**
 * Hot water setpoints, in °C: from 20 °C to the configured ceiling (55 °C by
 * default, 40 to 60 °C, never above 60 °C whatever is typed: scalding), and
 * always within the bounds the controller gives for the parameter.
 */
export const DHW = {
  min: 20,
  max: 60,
  ceilingMin: 40,
  ceilingDefault: 55,
};

/**
 * The heating season of the room thermostats (the `HVAC_MODE` parameter of
 * compit-inext-api: 0 winter = heating, 1 summer = heating off, 2 cooling).
 * Summer is the protective choice: never behind the option.
 */
export const SEASONS = {
  winter: 0,
  summer: 1,
  cooling: 2,
};
export const PROTECTIVE_SEASON = 'summer';

export const LIMITS = {
  /** Gladys: 300 states per minute; a margin is kept. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** An answer is read up to this size, then dropped (a device state: ~60 KB). */
  responseBytes: 1024 * 1024,
  /** What one account may hold: more is ignored. */
  gates: 8,
  devices: 32,
  /** Parameters read from one state answer (an R 900 lists ~450). */
  params: 2000,
  /** Errors kept from one state answer. */
  errors: 20,
  /** Names (gates, devices) are cut to this length. */
  nameLength: 60,
  /** A token longer than this is refused. */
  tokenLength: 4096,
  /** Token renewals after a 401 without any read going through: then a stop. */
  renewalsWithoutRead: 3,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One request of the polling. */
  requestTimeout: 15 * SECOND,
  /** The list of gates: at start, on a scan, then every 6 hours. */
  gatesInterval: 6 * HOUR,
  /** Never two sign-ins within a minute, even across a restart (persisted). */
  loginFloor: MINUTE,
  /** Failed polls: 1, 2, 5, then 10 minutes, never shorter than the interval. */
  backoff: [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE],
  /** An HTTP 429 or 5xx: a pause of 1 min to 6 h, persisted in /data. */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** A device that answers 401/403 while the gates read: its state again after 15 min, doubled up to 1 h. */
  deniedMin: 15 * MINUTE,
  deniedMax: HOUR,
  /** A controller whose last contact with the cloud is older than this is shown offline. */
  staleAfter: 30 * MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button reads at most this often. */
  testCooldown: 10 * SECOND,
  /** The button waits 30 s in Gladys: it answers by 25 s, the read going on if longer. */
  testBudget: 25 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): the fresh read and the write
   * must leave by 3.5 s after the click, or the command is refused unsent;
   * the answer is awaited until 4.3 s, after which the command is "sent,
   * without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The fresh read of a command: 2.2 s at most, and 0.3 s left to send after it. */
  commandReadMax: 2_200,
  commandMinRead: 300,
  commandMinSend: 300,
  /** After a write that may have left, the next non-protective command waits this long. */
  commandSpacing: 3 * SECOND,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A sent command keeps its guard until a read shows what it asked, or 90 s. */
  guard: 90 * SECOND,
};
