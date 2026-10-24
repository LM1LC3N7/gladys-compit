// -----------------------------------------------------------------------------
// The integration: the Compit iNext account typed in the configuration
// (e-mail address and password), one read of its devices every poll
// interval, one Gladys device per Compit device and its states, the
// transport badge, the "Test the connection" button, and three commands
// (the room setpoint, the hot water setpoint, the heating season), each
// refused unless its own option allows it, except "Summer" (the heating and
// the cooling of the installation off), the protective choice. index.js only
// wires the SDK handlers.
//
// Failures (lessons of the previous waves):
//   - account refused (wrong e-mail or password, a token refused right
//     after a sign-in, the registration of Gladys not accepted, a sign-in
//     request refused): a final stop persisted in /data, never an automatic
//     retry; saving other credentials, or "Test the connection" (one try,
//     never sooner than the interval), tries again, and only a success
//     lifts the stop;
//   - the token (no documented lifetime) is dropped only when the gates
//     refuse it (401), then renewed by signing in again, once; never two
//     sign-ins within a minute, even across a restart (the time of the last
//     one is kept in /data);
//   - a 401 on the state of one device: the token is confirmed on the gates
//     (one request); if the gates read with it, that device only is
//     "access refused" (also on 403), read again after 15 min, doubled up
//     to 1 h, never a new sign-in for it;
//   - a 5xx, a timeout or a bad answer on the state of one device: that
//     device only is "not read", spaced (one interval, doubled up to 1 h);
//     the other values of the read are kept. Only an HTTP 429, a failure of
//     the gates or of every device stops the whole read: 429/5xx a pause of
//     1 min to 6 h persisted in /data, applied to every path (except
//     "Summer": one try); anything else 1, 2, 5, 10 min, never sooner than
//     the interval;
//   - the time of the last read is kept in /data (before it leaves, at most
//     once a minute): a restart never reads sooner than the interval;
//   - a reconnection to Gladys clears none of them.
//
// The commands (rules learnt on the previous modules):
//   - non-protective ones (a setpoint, "Winter"): decided on a fresh read of
//     the device only, refused when a value is missing, when the parameter
//     is not writable or when the controller has not reached the cloud for
//     30 min; options and ceilings checked on arrival, after the fresh read
//     and right before the request leaves (beforeSend); sent within 3.5 s
//     of the click or refused unsent; one at a time per device; never
//     retried; never a sign-in inside them;
//   - "Summer": no option; it waits only for the departure of a write of
//     the device already leaving (never its answer), cancels a command of
//     the device not sent yet, is written without a fresh read, signs in by
//     itself when no token is held (or when its write gets a 401 and the
//     gates refuse the token too), once, within its budget, also during a
//     pause; after a write of the device that left before it, its guard is
//     sticky: the follow-up reads write "Summer" again (3 times at most) if
//     they show otherwise. Its refusal cases are listed in the docs;
//   - a write that may have reached iNext (silence, a dropped connection, a
//     5xx) is never answered "not sent": "sent, without confirmation", then
//     follow-up reads of the commanded devices only (grouped); the ack never
//     waits for a publication to Gladys.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { connectionKey, normalizeConfig, numberOf } from './config.js';
import {
  DHW,
  FEATURES as F,
  HOUR,
  MINUTE,
  PROTECTIVE_SEASON,
  SEASONS,
  SECOND,
  SETPOINT,
  TIMINGS,
} from './constants.js';
import { parameterOf } from './catalog.js';
import {
  COMMAND_ROLES,
  buildDevice,
  deviceIds,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
  reportedRoles,
  typeOfCreated,
} from './devices.js';
import { ERRORS, T, age, word } from './i18n.js';
import { devicesOf, gatesOf, isStale, seasonOf, stateOf } from './model.js';
import { CompitClient } from './compit/client.js';
import { CODES, CompitError, isAuthRefused, isBusy, reasonOf } from './compit/errors.js';
import { StatePublisher } from './publisher.js';
import {
  memoryStore,
  newUid,
  normalizeMemory,
  refusalPrint,
  serializeMemory,
  stopsOf,
} from './store.js';

/** Two temperatures (or season values) the API gives back as equal. */
const same = (a, b) => a !== undefined && b !== undefined && Math.abs(a - b) < 0.05;

const isHttp = (err, ...statuses) => err?.code === CODES.HTTP && statuses.includes(err.status);

const ROLE_OPTION = {
  [F.SETPOINT]: 'allowSetpoints',
  [F.DHW_SETPOINT]: 'allowDhw',
  [F.SEASON]: 'allowSeasons',
};
const ROLE_DISABLED = {
  [F.SETPOINT]: ERRORS.setpointsDisabled,
  [F.DHW_SETPOINT]: ERRORS.dhwDisabled,
  [F.SEASON]: ERRORS.seasonsDisabled,
};

export class CompitApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'compit' }),
    request,
    store = memoryStore(),
    now = Date.now,
    clock = () => performance.now(),
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    /** The HTTPS transport (tests); node:https otherwise. */
    this.request = request;
    this.store = store;
    /** Wall clock: /data, the deadlines given to the client. */
    this.now = now;
    /** Monotonic clock: the guards, spacings and waits kept in memory (a clock jump moves none). */
    this.clock = clock;
    this.timers = timers;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.account = undefined;
    /** What survives a restart (src/store.js), loaded at the first start. */
    this.memory = normalizeMemory(null, now());
    this.memoryLoaded = false;
    this.saveWarned = false;
    /** deviceId -> the roles seen during this run (a feature never disappears). */
    this.seen = new Map();
    this.generation = 0;
    this.started = false;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** When the last read of the polling began (monotonic), for the button. */
    this.lastAttemptAt = -Infinity;
    /** deviceId -> the non-protective command in flight (one at a time per device). */
    this.inFlight = new Map();
    /** deviceId -> no new non-protective command before this time: a write left just before. */
    this.quietUntil = new Map();
    /** deviceId -> the write of the device not answered yet (any kind). */
    this.writing = new Map();
    /** deviceId -> resolves when that write leaves (or ends): "Summer" waits for this only. */
    this.departures = new Map();
    /** deviceId -> counts the "Summer" commands: a command begun before one is not sent. */
    this.stopEpoch = new Map();
    /** deviceId -> when the last write of the device left (its beforeSend), any kind. */
    this.lastWriteAt = new Map();
    /** `${deviceId}:${role}` -> { from, expected, moved, until, sticky, resends, at }. */
    this.guards = new Map();
    /** Increases at every write that may have left: a read begun before it is dropped. */
    this.writes = 0;
  }

  // --- Lifecycle -------------------------------------------------------------

  freshAccount(config) {
    return {
      client: new CompitClient({
        email: config.email,
        password: config.password,
        uid: this.memory.uid,
        now: this.now,
        mayLogin: () => this.mayLogin(),
        onLogin: () => this.loggedIn(),
        ...(this.request ? { request: this.request } : {}),
      }),
      /** The gates of the account (src/model.js gatesOf), and when they were listed. */
      gates: undefined,
      gatesAt: -Infinity,
      /** Read the gates first at the next read (a 401 met by a command). */
      recheck: false,
      /** deviceId -> { id, label, type, gateId, gateLabel } of the gate list. */
      devices: new Map(),
      /** deviceId -> { state, serverTime } of the last read. */
      data: new Map(),
      /** deviceId -> { until, wait }: its state answered 401/403. */
      denied: new Map(),
      /** deviceId -> { until, wait, reason }: its state failed (5xx, timeout, bad answer). */
      failed: new Map(),
      online: undefined,
      failures: 0,
      wait: undefined,
      /** 'auth', 'busy', 'signIn', or a short reason. */
      error: undefined,
      timer: undefined,
      running: undefined,
      /** The follow-up reads after commands: one timer, the devices and their due times. */
      follow: { timer: undefined, due: [] },
      /** The follow-up read under way (separate from `running`, the periodic one). */
      following: undefined,
      /** When the first read comes after a restart (monotonic), else undefined. */
      firstAt: undefined,
    };
  }

  async loadMemory() {
    if (this.memoryLoaded) {
      return;
    }
    this.memoryLoaded = true;
    const raw = await this.store.load().catch(() => null);
    this.memory = normalizeMemory(raw, this.now());
    if (!this.memory.uid) {
      // One uid per installation, made once (saved before the first sign-in leaves).
      this.memory.uid = newUid();
    }
    // The sticky "Summer" guards of the previous run go on until their end.
    for (const { id, until } of this.memory.stops) {
      this.guards.set(`${id}:${F.SEASON}`, {
        from: undefined,
        expected: SEASONS[PROTECTIVE_SEASON],
        moved: true,
        // Kept in /data on the wall clock (bounded on reload), here on the monotonic one.
        until: this.clock() + Math.min(TIMINGS.guard, until - this.now()),
        sticky: true,
        resends: 0,
        at: this.clock(),
      });
    }
  }

  saveMemory() {
    this.memory.stops = stopsOf(this.guards, this.clock()).map(({ id, until }) => ({
      id,
      until: this.now() + (until - this.clock()),
    }));
    return this.store.save(serializeMemory(this.memory)).catch((err) => {
      if (!this.saveWarned) {
        this.saveWarned = true;
        this.logger.warn(`The state could not be saved in /data: ${err?.code ?? 'error'}`);
      }
    });
  }

  /** Never two sign-ins within a minute (persisted: a restart counts too). */
  mayLogin() {
    return this.now() - this.memory.lastLoginAt >= TIMINGS.loginFloor;
  }

  /** A sign-in is about to leave: its time is on disk first (a crash right after counts). */
  loggedIn() {
    this.memory.lastLoginAt = this.now();
    return this.saveMemory();
  }

  /** The print kept while refused (see src/store.js). */
  refusalPrint(reason) {
    return refusalPrint(this.memory.salt, reason, this.config.email, this.config.password);
  }

  /** The refusal of the account, lifted only for other credentials. Returns true when lifted. */
  async checkRefusal() {
    if (!this.memory.refused || this.config.problem) {
      return false;
    }
    if (this.memory.fp !== '' && this.memory.fp !== this.refusalPrint(this.memory.reason)) {
      // Other credentials than those refused (changed while stopped): tried.
      this.liftRefusal();
      await this.saveMemory();
      return true;
    }
    return false;
  }

  liftRefusal() {
    this.memory.refused = false;
    this.memory.fp = '';
    this.memory.reason = '';
  }

  async start(raw = {}, { changed = false } = {}) {
    const previous = this.account;
    this.stop();
    await previous?.running;
    await this.loadMemory();
    this.config = normalizeConfig(raw);
    const lifted = await this.checkRefusal();
    this.account = this.config.problem ? undefined : this.freshAccount(this.config);
    // The roles are those this account reports from now on (the created
    // features are kept anyway by keepCreatedFeatures).
    this.seen.clear();
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.account) {
      // The devices already created are shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, T.connecting);
    // A restart never reads sooner than the interval after the last read
    // (other credentials are tried at once).
    const since = this.now() - this.memory.lastReadAt;
    const wait = changed || lifted ? 0 : Math.min(this.interval, this.interval - since);
    if (wait > 0 && !this.memory.refused) {
      this.lastAttemptAt = this.clock() - since;
      // The first read comes after the wait, and never during a pause (schedule).
      const paused = Math.max(0, this.memory.pausedUntil - this.now());
      this.account.firstAt = this.clock() + Math.max(wait, paused);
      this.schedule(wait);
      // The sticky "Summer" guards of the previous run are checked by their
      // follow-up reads (5 s, 20 s), whatever the wait (one sign-in a minute).
      const stops = [...this.guards.entries()].filter(
        ([key, g]) => g.sticky && /:season$/.test(key),
      );
      for (const [key] of stops) {
        const id = Number(key.split(':')[0]);
        for (const delay of TIMINGS.followUps) {
          this.account.follow.due.push({ id, at: this.clock() + delay });
        }
      }
      this.account.follow.due.sort((a, b) => a.at - b.at);
      this.armFollow(this.account);
      // Discovery and status meanwhile: the devices already created, the next read.
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  stop() {
    this.generation += 1;
    if (this.account) {
      this.clearTimer();
      if (this.account.follow.timer) {
        this.timers.clearTimeout(this.account.follow.timer);
        this.account.follow.timer = undefined;
      }
      this.account.client.close();
    }
    this.publisher.stop();
  }

  clearTimer() {
    if (this.account?.timer) {
      this.timers.clearTimeout(this.account.timer);
      this.account.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badges) and the last states. The client, its token, the pause and
   * the stop on a refused account stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    const next = normalizeConfig(raw);
    if (
      next.pollInterval !== this.config.pollInterval ||
      connectionKey(next) !== connectionKey(this.config)
    ) {
      await this.configUpdated(raw);
      return;
    }
    this.config = next;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.publishAll();
  }

  /**
   * Saved by the user. Other credentials lift the stop on a refused account
   * (never the minute between two sign-ins, nor a pause). The options, the
   * ceilings and the language apply at once.
   */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    if (connectionKey(next) !== connectionKey(this.config)) {
      if (this.memory.refused) {
        this.liftRefusal();
        await this.saveMemory();
      }
      await this.start(raw, { changed: true });
      return;
    }
    const previous = this.config;
    this.config = next;
    if (next.pollInterval !== previous.pollInterval && this.account && !this.account.running) {
      // Only the interval: the account, its client and its token stay; the
      // next read follows the new interval (a backoff or a pause still holds).
      this.schedule();
    }
    if (
      next.allowSetpoints !== previous.allowSetpoints ||
      next.allowDhw !== previous.allowDhw ||
      next.allowSeasons !== previous.allowSeasons
    ) {
      const on = (value) => (value ? 'allowed' : 'off');
      this.logger.info(
        `Compit commands: room setpoints ${on(next.allowSetpoints)}, hot water ${on(next.allowDhw)}, seasons ${on(next.allowSeasons)}`,
      );
    }
    if (next.language !== previous.language) {
      this.published = undefined;
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = undefined;
      this.logger.warn(`setConnectionStatus failed: ${err.message}`);
    });
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The next read: after a backoff when the last one failed, else the interval. Never while refused. */
  schedule(first) {
    const account = this.account;
    this.clearTimer();
    if (this.memory.refused) {
      // A final stop: only the user (other credentials, the button) tries again.
      return;
    }
    const base =
      first ?? (account.online === false ? (account.wait ?? this.interval) : this.interval);
    const paused = Math.max(0, this.memory.pausedUntil - this.now());
    const wait = Math.max(base, paused, 0);
    const generation = this.generation;
    account.timer = this.timers.setTimeout(() => {
      account.timer = undefined;
      if (generation === this.generation) {
        this.tick().catch(() => this.logger.error('Compit refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. `force`: the user asked. */
  tick({ force = false } = {}) {
    const account = this.account;
    if (!account) {
      return Promise.resolve();
    }
    if (!account.running) {
      account.running = this.run(account, { force }).finally(() => {
        account.running = undefined;
      });
    }
    return account.running;
  }

  async run(account, { force }) {
    // A follow-up read under way ends first (one read at a time); the timer
    // is armed again at the end whatever happens (schedule, below).
    while (account.following) {
      await account.following.catch(() => {});
    }
    const generation = this.generation;
    const now = this.now();
    if (this.memory.pausedUntil > now) {
      this.halted(account, 'busy', this.memory.pausedUntil - now);
    } else if (this.memory.refused && !force) {
      this.halted(account, 'auth', undefined);
    } else {
      this.lastAttemptAt = this.clock();
      if (now - this.memory.lastReadAt >= MINUTE) {
        // On disk before the read leaves (at most once a minute).
        this.memory.lastReadAt = now;
        await this.saveMemory();
      }
      try {
        await this.read(account, generation);
      } catch (err) {
        if (generation !== this.generation) {
          return;
        }
        this.failed(account, err);
      }
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule();
    }
  }

  /** Nothing requested: a pause or a stop holds. */
  halted(account, error, wait) {
    account.online = false;
    account.error = error;
    account.wait = wait;
  }

  /**
   * One read: the gates when due, then the state of every device (or of
   * `only`, the commanded devices of a follow-up read). Throws for what
   * concerns the whole account; keeps a failure of one device to it.
   */
  async read(account, generation, { only } = {}) {
    const { client } = account;
    const writes = this.writes;
    const due = this.clock() - account.gatesAt >= TIMINGS.gatesInterval;
    // No token held (a renewal that could not leave, a restart): the gates
    // sign in again, also for a follow-up read.
    if (!account.gates || !client.hasSession || (!only && (due || account.recheck))) {
      try {
        const gates = gatesOf((await client.gates()).data);
        if (!gates) {
          throw new CompitError(CODES.BAD_ANSWER, { sent: true });
        }
        account.gates = gates;
        account.devices = devicesOf(gates);
        account.gatesAt = this.clock();
        account.recheck = false;
      } catch (err) {
        // A list that fails while the devices are known never stops their reads.
        const fatal = isAuthRefused(err) || isBusy(err) || err.code === CODES.NO_SESSION;
        if (!account.gates || fatal) {
          throw err;
        }
        this.logger.warn(`Compit: the list of devices failed (${reasonOf(err)})`);
        account.gatesAt = this.clock() - TIMINGS.gatesInterval + TIMINGS.backoff.at(-1);
      }
    }
    if (generation !== this.generation) {
      return;
    }
    const fresh = new Map();
    let confirmed = false;
    let attempted = 0;
    let failedCount = 0;
    let lastError;
    for (const id of only ?? [...account.devices.keys()]) {
      if (!account.devices.has(id)) {
        continue;
      }
      if (!only && this.waiting(account.denied.get(id), TIMINGS.deniedMax)) {
        continue;
      }
      if (!only && this.waiting(account.failed.get(id), HOUR)) {
        continue;
      }
      attempted += 1;
      let answer;
      let error;
      try {
        answer = await client.state(id);
      } catch (err) {
        error = err;
      }
      if (generation !== this.generation) {
        return;
      }
      if (error && isHttp(error, 401) && !confirmed) {
        // Is the token still good? Asked once per read, on the gates: a
        // refusal there goes the normal way (renewal, or a stop).
        const how = await client.confirmToken();
        confirmed = true;
        if (generation !== this.generation) {
          return;
        }
        if (how === 'renewed') {
          error = undefined;
          try {
            answer = await client.state(id);
          } catch (err) {
            error = err;
          }
          if (generation !== this.generation) {
            return;
          }
        }
      }
      if (error) {
        if (isHttp(error, 401, 403)) {
          // The gates read with this token: this device only is refused.
          const denied = account.denied.get(id);
          const wait = Math.min(TIMINGS.deniedMax, denied ? denied.wait * 2 : TIMINGS.deniedMin);
          account.denied.set(id, { until: this.clock() + wait, wait });
          account.data.delete(id);
          this.logger.warn(`Compit: access to device ${id} refused (HTTP ${error.status})`);
          attempted -= 1;
          continue;
        }
        if (isHttp(error, 404)) {
          // No longer on the account: listed again at the next read.
          account.gatesAt = -Infinity;
          account.data.delete(id);
          attempted -= 1;
          continue;
        }
        if (isHttp(error, 429) || isAuthRefused(error) || error.code === CODES.NO_SESSION) {
          throw error;
        }
        this.deviceFailed(account, id, error);
        failedCount += 1;
        lastError = error;
        continue;
      }
      const state = stateOf(answer.data);
      if (!state) {
        const bad = new CompitError(CODES.BAD_ANSWER, { sent: true });
        this.deviceFailed(account, id, bad);
        failedCount += 1;
        lastError = bad;
        continue;
      }
      account.denied.delete(id);
      account.failed.delete(id);
      fresh.set(id, { state, serverTime: answer.serverTime });
    }
    if (!only && attempted > 0 && failedCount === attempted) {
      // Every device failed: the account, not one device.
      throw lastError;
    }
    for (const id of [...account.data.keys()]) {
      if (!account.devices.has(id)) {
        account.data.delete(id);
      }
    }
    for (const [id, entry] of fresh) {
      // A command wrote meanwhile: this read may predate it; the follow-ups read again.
      if (this.writes === writes || !account.data.has(id)) {
        account.data.set(id, entry);
      }
    }
    account.online = true;
    account.failures = 0;
    account.wait = undefined;
    account.error = undefined;
    if (this.memory.refused) {
      // The button tried and it went through: the stop is lifted, the fingerprint erased.
      this.liftRefusal();
      await this.saveMemory();
    }
    if (this.writes === writes) {
      this.observe(account);
    }
  }

  /** Whether a device spacing still holds (capped at each use). */
  waiting(entry, max) {
    return Boolean(entry) && Math.min(entry.until, this.clock() + max) > this.clock();
  }

  /** The state of one device failed (5xx, timeout, bad answer): that device only, spaced. */
  deviceFailed(account, id, err) {
    const previous = account.failed.get(id);
    const wait = Math.min(HOUR, previous ? previous.wait * 2 : this.interval);
    account.failed.set(id, { until: this.clock() + wait - SECOND, wait, reason: reasonOf(err) });
    this.logger.warn(`Compit: device ${id} not read (${reasonOf(err)})`);
  }

  /**
   * A refusal of the account or a 429/5xx, met by any request: the stop or
   * the pause, persisted. Returns { kind, wait }, or undefined for any other error.
   */
  block(err) {
    const now = this.now();
    if (isAuthRefused(err)) {
      this.memory.refused = true;
      this.memory.reason = err.reason ?? 'login';
      this.memory.fp = this.refusalPrint(this.memory.reason);
      void this.saveMemory();
      this.logger.warn(
        `Compit refused the account (${this.memory.reason}, HTTP ${err.status ?? '?'}): stopped, no automatic retry`,
      );
      return { kind: 'auth', wait: undefined };
    }
    if (isBusy(err)) {
      const step =
        TIMINGS.backoff[Math.min(this.account?.failures ?? 0, TIMINGS.backoff.length - 1)];
      const wait = Math.min(
        TIMINGS.pauseMax,
        Math.max(TIMINGS.pauseMin, this.interval, err.retryAfterMs ?? step),
      );
      this.memory.pausedUntil = Math.max(this.memory.pausedUntil, now + wait);
      void this.saveMemory();
      this.logger.warn(`Compit busy (HTTP ${err.status}): paused for ${Math.round(wait / 1000)} s`);
      return { kind: 'busy', wait };
    }
    return undefined;
  }

  failed(account, err) {
    account.online = false;
    const blocked = this.block(err);
    if (blocked) {
      account.error = blocked.kind;
      account.wait = blocked.wait;
      account.failures += 1;
      return;
    }
    if (err.code === CODES.NO_SESSION) {
      // A sign-in left less than a minute ago: the next one as soon as the
      // minute is over (nothing was read: no read is repeated sooner).
      account.error = 'signIn';
      account.wait = Math.max(SECOND, this.memory.lastLoginAt + TIMINGS.loginFloor - this.now());
      return;
    }
    const reason = reasonOf(err);
    // Never read again sooner than the interval.
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(account.failures, TIMINGS.backoff.length - 1)],
    );
    account.failures += 1;
    account.wait = wait;
    account.error = reason;
    this.logger.warn(`Compit: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  // --- What the account gives -------------------------------------------------

  /** Whether the values of the last read are current. */
  get live() {
    return Boolean(this.account?.online === true && this.account.gates);
  }

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((d) => d?.external_id === externalId);
  }

  /** Our created devices: [{ device, deviceId }]. */
  ourDevices() {
    const list = [];
    for (const device of this.gladys.devices ?? []) {
      const deviceId = parseDeviceId(device?.external_id);
      if (
        deviceId !== undefined &&
        deviceIds(this.gladys, deviceId).device === device.external_id
      ) {
        list.push({ device, deviceId });
      }
    }
    return list;
  }

  /** The type code of a device: from the gate list, else from the created device. */
  typeOf(deviceId) {
    const listed = this.account?.devices.get(deviceId)?.type;
    if (listed !== undefined) {
      return listed;
    }
    return typeOfCreated(this.createdDevice(deviceIds(this.gladys, deviceId).device));
  }

  /**
   * How a device stands: 'online', 'stale' (its controller has not reached
   * the cloud), 'denied', 'error' (its state failed), 'unknown' (listed, its
   * state not read yet), 'offline' (iNext does not answer) or 'gone' (no
   * longer on the account). undefined while a first read is under way.
   */
  standing(deviceId) {
    if (this.live) {
      if (!this.account.devices.has(deviceId)) {
        return 'gone';
      }
      if (this.account.denied.has(deviceId)) {
        return 'denied';
      }
      if (this.account.failed.has(deviceId)) {
        return 'error';
      }
      const entry = this.account.data.get(deviceId);
      if (!entry) {
        return 'unknown';
      }
      return isStale(entry.state, entry.serverTime) ? 'stale' : 'online';
    }
    if (!this.account || this.account.online === false) {
      return 'offline';
    }
    return undefined;
  }

  /** The roles of a device: those seen during this run, plus those the last read reports. */
  rolesFor(deviceId) {
    const seen = this.seen.get(deviceId) ?? new Set();
    const entry = this.live ? this.account.data.get(deviceId) : undefined;
    const type = this.typeOf(deviceId);
    for (const role of reportedRoles(type, entry?.state)) {
      seen.add(role);
    }
    this.seen.set(deviceId, seen);
    return seen;
  }

  // --- Gladys ----------------------------------------------------------------

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /**
   * The Discovery list: the devices whose state was read, and the devices
   * already created (even unreachable now, or gone), as they are.
   */
  async publishDevices() {
    const ids = new Set(this.account?.data.keys() ?? []);
    for (const { deviceId } of this.ourDevices()) {
      ids.add(deviceId);
    }
    const devices = [...ids].map((deviceId) =>
      buildDevice(this.gladys, deviceId, {
        roles: this.rolesFor(deviceId),
        info: this.account?.devices.get(deviceId),
        type: this.typeOf(deviceId),
        language: this.config.language,
        created: this.createdDevice(deviceIds(this.gladys, deviceId).device),
      }),
    );
    if (devices.length === 0) {
      return;
    }
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  queueStates(created = this.createdFeatures()) {
    for (const { deviceId } of this.ourDevices()) {
      const status = this.standing(deviceId);
      if (status === undefined) {
        continue;
      }
      const states = deviceStates(deviceIds(this.gladys, deviceId), {
        type: this.typeOf(deviceId),
        state: status === 'online' ? this.account.data.get(deviceId).state : undefined,
        status,
        language: this.config.language,
      });
      for (const { device_feature_external_id: id, ...value } of states) {
        if (created.has(id)) {
          this.publisher.push(id, value);
        }
      }
    }
  }

  async publishBadge() {
    const entries = [];
    for (const { device, deviceId } of this.ourDevices()) {
      const status = this.standing(deviceId);
      if (status === undefined) {
        continue;
      }
      entries.push({
        external_id: device.external_id,
        transport: status === 'online' ? DEVICE_TRANSPORTS.CLOUD : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** The connection status of the configuration screen. */
  async updateStatus() {
    const [connected, message] = this.status();
    await this.setStatus(connected, message);
  }

  status() {
    const account = this.account;
    if (!account) {
      return [false, T.problem(this.config.problem)];
    }
    if (this.memory.refused) {
      return [false, T.refused(this.memory.reason)];
    }
    if (account.online === false) {
      const wait = age(account.wait ?? this.interval);
      switch (account.error) {
        case 'busy':
          return [false, T.busy(wait)];
        case 'signIn':
          return [false, T.signInWait(wait)];
        default:
          return [false, T.unreachable(account.error ?? 'error', wait)];
      }
    }
    if (!this.live) {
      const first = account.firstAt === undefined ? 0 : account.firstAt - this.clock();
      return [false, first > 0 ? T.nextRead(age(first)) : T.connecting];
    }
    if (account.devices.size === 0) {
      return [true, T.noDevice];
    }
    let text = T.connected(account.gates.length, account.devices.size);
    if (account.denied.size > 0) {
      text = T.join(text, T.denied(account.denied.size));
    }
    if (account.failed.size > 0) {
      text = T.join(text, T.notRead(account.failed.size));
    }
    return [true, text];
  }

  /** A device was created (or updated): send its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the devices listed again at the next read. */
  async scan() {
    if (this.account) {
      this.account.gatesAt = -Infinity;
    }
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button --------------------------------------------------

  /**
   * Reads now (even after a refused account: the user asked: one try), but
   * never sooner than the interval (10 s at least) after the last read; else
   * the current state and when the next read may come.
   */
  async testConnection() {
    if (!this.account) {
      return this.status()[1];
    }
    const floor = Math.max(TIMINGS.testCooldown, this.interval);
    const since = this.clock() - this.lastAttemptAt;
    if (since < floor) {
      const last = JSON.parse(this.lastStatus ?? '[false,null]')[1];
      const next = T.test.next(age(floor - since));
      return last ? T.join(next, last) : next;
    }
    // A pause (429/5xx) and the minute between two sign-ins hold even for
    // the button; a read in progress is joined. Gladys waits 30 s for the
    // button: the answer comes by 25 s.
    let handle;
    const limit = new Promise((resolve) => {
      handle = this.timers.setTimeout(resolve, TIMINGS.testBudget);
    });
    await Promise.race([this.tick({ force: true }), limit]);
    this.timers.clearTimeout(handle);
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? T.connecting;
  }

  // --- The commands --------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  /** The bounds of the configuration for a setpoint role, in °C. */
  bounds(role) {
    return role === F.SETPOINT
      ? { low: SETPOINT.min, high: Math.min(SETPOINT.max, this.config.roomCeiling) }
      : { low: DHW.min, high: Math.min(DHW.max, this.config.dhwCeiling) };
  }

  /**
   * The value of a command, checked strictly (null, '' or 'abc' are not a
   * number; a season is one of the exact option values; hot water in whole
   * degrees), within the bounds of the configuration.
   */
  parseCommand(role, value) {
    if (role === F.SEASON) {
      if (typeof value !== 'string' || !Object.hasOwn(SEASONS, value)) {
        throw this.refusal(ERRORS.badSeason);
      }
      return { season: value, value: SEASONS[value] };
    }
    const number = numberOf(value);
    if (number === undefined) {
      throw this.refusal(ERRORS.badNumber);
    }
    if (role === F.DHW_SETPOINT && !Number.isInteger(number)) {
      throw this.refusal(ERRORS.badWhole);
    }
    if (Math.abs(number * 10 - Math.round(number * 10)) > 1e-6) {
      throw this.refusal(ERRORS.badStep);
    }
    const rounded = Math.round(number * 10) / 10;
    const { low, high } = this.bounds(role);
    if (rounded < low || rounded > high) {
      throw this.refusal(ERRORS.outOfRange(low, high));
    }
    return { value: rounded };
  }

  async setValue(device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseFeatureId(feature?.external_id);
    if (!target || !COMMAND_ROLES.includes(target.role)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const wanted = this.parseCommand(target.role, value);
    if (target.role === F.SEASON && wanted.season === PROTECTIVE_SEASON) {
      return this.protect(target, received);
    }
    if (!this.config[ROLE_OPTION[target.role]]) {
      throw this.refusal(ROLE_DISABLED[target.role]);
    }
    if (wanted.season === 'cooling') {
      throw this.refusal(ERRORS.cooling);
    }
    const { deviceId } = target;
    const quiet = Math.min(
      this.quietUntil.get(deviceId) ?? -Infinity,
      this.clock() + TIMINGS.commandSpacing,
    );
    if (this.inFlight.has(deviceId) || this.clock() < quiet) {
      throw this.refusal(ERRORS.stillRunning);
    }
    const promise = this.command(target, wanted, received);
    this.inFlight.set(deviceId, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(deviceId) === promise) {
        this.inFlight.delete(deviceId);
      }
    }
  }

  /** The checks of a non-protective command before sending, on the latest configuration and state. */
  checkBeforeSend({ generation, account, role, deviceId, epoch, value, range }) {
    if (!this.config[ROLE_OPTION[role]]) {
      throw this.refusal(ROLE_DISABLED[role]);
    }
    if ((this.stopEpoch.get(deviceId) ?? 0) !== epoch) {
      throw this.refusal(ERRORS.stopped);
    }
    if (this.memory.refused) {
      throw this.refusal(ERRORS.refusedAccount);
    }
    if (this.memory.pausedUntil > this.now()) {
      throw this.refusal(ERRORS.paused);
    }
    if (generation !== this.generation || this.account !== account) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (!this.live) {
      throw this.refusal(account.online === false ? ERRORS.lastReadFailed : ERRORS.notReadYet);
    }
    if (!account.client.hasSession) {
      throw this.refusal(account.client.signingIn ? ERRORS.signingIn : ERRORS.noSession);
    }
    if (role !== F.SEASON && value !== undefined) {
      // The ceiling may have been lowered since the command arrived.
      const { low, high } = this.rangeOf(role, range ?? {});
      if (value < low || value > high) {
        throw this.refusal(ERRORS.outOfRange(low, high));
      }
    }
  }

  /** The bounds the controller gives for a parameter, intersected with ours (whole degrees for hot water). */
  rangeOf(role, param) {
    const { low, high } = this.bounds(role);
    let lo = Math.max(low, param.min ?? param.low ?? low);
    let hi = Math.min(high, param.max ?? param.high ?? high);
    if (role === F.DHW_SETPOINT) {
      lo = Math.ceil(lo);
      hi = Math.floor(hi);
    }
    return { low: lo, high: hi };
  }

  async command(target, wanted, received) {
    const generation = this.generation;
    const account = this.account;
    const { deviceId, role } = target;
    const epoch = this.stopEpoch.get(deviceId) ?? 0;
    const sendBy = received + TIMINGS.commandSendBy;
    const context = { generation, account, role, deviceId, epoch };
    this.checkBeforeSend({ ...context, value: wanted.value });
    const type = account.devices.get(deviceId)?.type;
    const code = type === undefined ? undefined : parameterOf(role, type);
    if (code === undefined) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const readBy = Math.min(this.now() + TIMINGS.commandReadMax, sendBy - TIMINGS.commandMinSend);
    if (readBy - this.now() < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }
    // The fresh read: the device now, never the values in memory.
    let answer;
    try {
      answer = await account.client.freshState(deviceId, { answerBy: readBy });
    } catch (err) {
      if (!(err instanceof CompitError)) {
        throw err;
      }
      if (err.code === CODES.LATE || err.code === CODES.TIMEOUT) {
        throw this.refusal(ERRORS.tooSlow);
      }
      if (err.code === CODES.NO_SESSION) {
        throw this.refusal(ERRORS.noSession);
      }
      if (isHttp(err, 401, 403)) {
        // The token is kept: the next read confirms it on the gates first.
        account.recheck = true;
        throw this.refusal(ERRORS.deviceDenied(err.status));
      }
      this.block(err);
      throw this.refusal(ERRORS.unknownState(reasonOf(err)));
    }
    const state = stateOf(answer.data);
    if (!state) {
      throw this.refusal(ERRORS.missingValue);
    }
    if (isStale(state, answer.serverTime)) {
      throw this.refusal(ERRORS.stale);
    }
    const param = state.params.get(code);
    if (!param || param.value === undefined) {
      throw this.refusal(ERRORS.missingValue);
    }
    if (!param.write) {
      throw this.refusal(ERRORS.notWritable);
    }
    let range;
    if (role === F.SEASON) {
      if (seasonOf(param.value) === undefined) {
        throw this.refusal(ERRORS.missingValue);
      }
    } else {
      range = this.rangeOf(role, param);
      if (range.low > range.high) {
        throw this.refusal(ERRORS.noRange);
      }
      if (wanted.value < range.low || wanted.value > range.high) {
        throw this.refusal(ERRORS.outOfRange(range.low, range.high));
      }
    }
    const key = `${deviceId}:${role}`;
    const current = param.value;
    if (same(current, wanted.value) && !this.guardActive(key)) {
      // Already so: nothing sent.
      return;
    }
    // The options may have been turned off during the read: checked again.
    const checks = { ...context, value: wanted.value, range };
    this.checkBeforeSend(checks);
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
    this.logger.info(`Compit device ${deviceId} ${role}: ${wanted.season ?? wanted.value}`);
    const options = {
      startBy: sendBy,
      answerBy: received + TIMINGS.commandAnswerBy,
      // The very last check, once the connection is up, right before the
      // request leaves (called once, by the transport).
      beforeSend: () => {
        this.checkBeforeSend(checks);
        if (role === F.SEASON && this.guards.get(key)?.sticky) {
          // A start really leaving, newer than the "Summer": its sticky
          // guard ends here, synchronously, before the write.
          this.guards.delete(key);
          void this.saveMemory();
        }
      },
    };
    try {
      await this.write(account, deviceId, code, wanted.value, options);
    } catch (err) {
      if (err.beforeSend) {
        throw err;
      }
      const reason = reasonOf(err);
      this.logger.warn(`Compit device ${deviceId} ${role}: write failed (${reason})`);
      if (!err.sent) {
        // Nothing reached iNext.
        throw this.refusal(err.code === CODES.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      if (err.code === CODES.HTTP && err.status >= 400 && err.status <= 499) {
        // Refused by iNext (token, request, rate): not applied.
        if (isHttp(err, 401)) {
          account.recheck = true;
        }
        this.block(err);
        this.followUp(account, deviceId);
        throw this.refusal(ERRORS.refused(reason));
      }
      // A silence, a dropped connection, a 5xx: the write may have reached iNext.
      this.block(err);
      this.guardUnlessStopped(key, deviceId, epoch, { from: current, expected: wanted.value });
      this.followUp(account, deviceId);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    this.guardUnlessStopped(key, deviceId, epoch, { from: current, expected: wanted.value });
    this.followUp(account, deviceId);
  }

  /** The guard of a command, unless a "Summer" came after it (its guard wins). */
  guardUnlessStopped(key, deviceId, epoch, plan) {
    if ((this.stopEpoch.get(deviceId) ?? 0) === epoch) {
      this.guard(key, plan);
    }
  }

  /**
   * One write of a device. Its departure (the transport's beforeSend, once
   * the connection is up) and its end are kept: "Summer" waits for the
   * departure of a previous write only, never for its answer.
   */
  write(account, deviceId, code, value, options) {
    let departed;
    const departure = new Promise((resolve) => {
      departed = resolve;
    });
    const inner = options.beforeSend;
    const promise = account.client.setParameter(deviceId, code, value, {
      ...options,
      beforeSend: () => {
        inner?.();
        this.lastWriteAt.set(deviceId, this.clock());
        departed();
      },
    });
    const tracked = promise.finally(() => {
      departed();
      if (this.writing.get(deviceId) === tracked) {
        this.writing.delete(deviceId);
      }
      if (this.departures.get(deviceId) === departure) {
        this.departures.delete(deviceId);
      }
    });
    this.writing.set(deviceId, tracked);
    this.departures.set(deviceId, departure);
    return tracked;
  }

  /** Waits for `promise` until `by` (wall clock); 'late' after it. */
  async within(promise, by) {
    let handle;
    const late = new Promise((resolve) => {
      handle = this.timers.setTimeout(() => resolve('late'), Math.max(0, by - this.now()));
    });
    try {
      return await Promise.race([promise, late]);
    } finally {
      this.timers.clearTimeout(handle);
    }
  }

  /**
   * A session for "Summer": the token held, or a sign-in made (or joined)
   * now, within the budget, also during a pause (one try). Throws the
   * refusal with its true cause.
   */
  async sessionFor(account, by) {
    const { client } = account;
    if (client.hasSession) {
      return;
    }
    if (this.memory.refused) {
      throw this.refusal(ERRORS.refusedAccount);
    }
    if (!client.signingIn && !this.mayLogin()) {
      const wait = this.memory.lastLoginAt + TIMINGS.loginFloor - this.now();
      throw this.refusal(ERRORS.loginFloor(age(wait)));
    }
    const login = client.login({ answerBy: by }).then(
      () => 'done',
      (err) => err,
    );
    const outcome = await this.within(login, by);
    if (outcome === 'late') {
      throw this.refusal(ERRORS.tooSlow);
    }
    if (outcome !== 'done') {
      throw this.signInRefusal(outcome);
    }
  }

  /** The refusal of "Summer" after a sign-in (or a check of the token) that failed. */
  signInRefusal(err) {
    if (isAuthRefused(err)) {
      this.block(err);
      return this.refusal(ERRORS.refusedAccount);
    }
    if (err?.code === CODES.NO_SESSION) {
      const wait = this.memory.lastLoginAt + TIMINGS.loginFloor - this.now();
      return this.refusal(ERRORS.loginFloor(age(Math.max(SECOND, wait))));
    }
    if (err?.code === CODES.LATE || err?.code === CODES.TIMEOUT) {
      return this.refusal(ERRORS.tooSlow);
    }
    this.block(err);
    return this.refusal(ERRORS.notSent(reasonOf(err)));
  }

  /**
   * "Summer" (heating and cooling of the installation off): the protective
   * choice. No option, through a pause (one try), it signs in by itself when
   * needed. Refused only when it cannot leave: see the docs (the same list).
   */
  async protect(target, received) {
    const { deviceId } = target;
    const key = `${deviceId}:${F.SEASON}`;
    // Cancels any non-protective command of this device not sent yet.
    this.stopEpoch.set(deviceId, (this.stopEpoch.get(deviceId) ?? 0) + 1);
    const account = this.account;
    const sendBy = received + TIMINGS.commandSendBy;
    const lastBy = sendBy - TIMINGS.commandMinSend;
    if (!account) {
      throw this.refusal(ERRORS.noAccount);
    }
    const type = this.typeOf(deviceId);
    const code = type === undefined ? undefined : parameterOf(F.SEASON, type);
    if (code === undefined) {
      throw this.refusal(ERRORS.unknownType);
    }
    // Only the departure of a write already leaving is awaited (never its answer).
    const leaving = this.departures.get(deviceId);
    const earlier = this.writing.has(deviceId);
    if (leaving && (await this.within(leaving, lastBy)) === 'late') {
      throw this.refusal(ERRORS.tooSlow);
    }
    await this.sessionFor(account, lastBy);
    // A write of the device that left before this one may still be applied
    // after it: the guard is then sticky (written again by the follow-ups).
    const sticky =
      earlier || this.clock() - (this.lastWriteAt.get(deviceId) ?? -Infinity) < TIMINGS.guard;
    this.logger.info(`Compit device ${deviceId} season: summer (heating off)`);
    const expected = SEASONS[PROTECTIVE_SEASON];
    const options = {
      startBy: sendBy,
      answerBy: received + TIMINGS.commandAnswerBy,
      beforeSend: () => {
        if (this.account !== account) {
          throw this.refusal(ERRORS.noAccount);
        }
      },
    };
    let retried = false;
    for (;;) {
      try {
        await this.write(account, deviceId, code, expected, options);
        break;
      } catch (err) {
        if (err.beforeSend) {
          throw err;
        }
        if (isHttp(err, 401) && !retried && this.now() < lastBy) {
          // Is it the token? Checked on the gates (renewed if refused there),
          // then written once more; else this device refuses the write.
          retried = true;
          const how = await this.within(
            account.client.confirmToken().then(
              (value) => value,
              (failure) => failure,
            ),
            lastBy,
          );
          if (how === 'late') {
            throw this.refusal(ERRORS.tooSlow);
          }
          if (how === 'renewed') {
            continue;
          }
          if (how !== 'valid') {
            throw this.signInRefusal(how);
          }
        }
        const reason = reasonOf(err);
        this.logger.warn(`Compit device ${deviceId} season summer: write failed (${reason})`);
        if (!err.sent) {
          throw this.refusal(err.code === CODES.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason));
        }
        if (err.code === CODES.HTTP && err.status >= 400 && err.status <= 499) {
          this.block(err);
          this.followUp(account, deviceId, { quiet: false });
          throw this.refusal(ERRORS.refused(reason));
        }
        this.block(err);
        this.guard(key, { from: undefined, expected, sticky: true });
        this.followUp(account, deviceId, { quiet: false });
        throw this.refusal(ERRORS.sentUnconfirmed(reason));
      }
    }
    this.guard(key, { from: undefined, expected, sticky });
    this.followUp(account, deviceId, { quiet: false });
  }

  /**
   * After a command: follow-up reads of the commanded devices only, 5 s
   * then 20 s after it, grouped (one timer per account, one read for every
   * device due).
   */
  followUp(account, deviceId, { quiet = true } = {}) {
    this.writes += 1;
    if (quiet) {
      // A write may have left: the next command of the device waits a
      // little, so that two settings are never written back to back.
      this.quietUntil.set(deviceId, this.clock() + TIMINGS.commandSpacing);
    }
    const now = this.clock();
    const { follow } = account;
    for (const delay of TIMINGS.followUps) {
      follow.due.push({ id: deviceId, at: now + delay });
    }
    // Bounded: a scene sending commands in a loop never piles up more.
    follow.due = follow.due.sort((a, b) => a.at - b.at).slice(-64);
    this.armFollow(account);
  }

  armFollow(account) {
    const { follow } = account;
    if (follow.timer || follow.due.length === 0) {
      return;
    }
    const generation = this.generation;
    const wait = Math.max(0, follow.due[0].at - this.clock());
    follow.timer = this.timers.setTimeout(() => {
      follow.timer = undefined;
      if (generation !== this.generation) {
        return;
      }
      const now = this.clock();
      const ids = new Set(follow.due.filter((d) => d.at <= now + 100).map((d) => d.id));
      follow.due = follow.due.filter((d) => d.at > now + 100);
      this.followRead(account, [...ids]).finally(() => this.armFollow(account));
    }, wait);
  }

  /**
   * A follow-up read, with its own promise (`account.following`): a
   * periodic read under way delays it (never drops it), and a periodic read
   * waits for it. Never during a pause or a stop; it may sign in (at most
   * once a minute) when no token is held, through the gates.
   */
  async followRead(account, ids) {
    while (account.running || account.following) {
      await (account.running ?? account.following).catch(() => {});
    }
    if (
      account !== this.account ||
      account.online === false ||
      this.memory.refused ||
      this.memory.pausedUntil > this.now()
    ) {
      return;
    }
    const generation = this.generation;
    account.following = (async () => {
      try {
        await this.read(account, generation, { only: ids });
      } catch (err) {
        if (generation === this.generation) {
          // Only a pause or a stop is kept: the next poll tells the rest.
          this.block(err);
        }
        return;
      }
      if (generation === this.generation) {
        await this.publishAll();
      }
    })().finally(() => {
      account.following = undefined;
    });
    await account.following;
  }

  // --- Guards ----------------------------------------------------------------------

  /**
   * After a command, until a read shows it: a new command is always sent,
   * never answered "already so" on a value that may not show the previous
   * one yet. The start value is kept: a read equal to it lifts nothing
   * until a move was seen. A sticky guard ("Summer" after another write) is
   * lifted by time only, and kept in /data.
   */
  guard(key, { from, expected, sticky = false }) {
    this.guards.set(key, {
      from,
      expected,
      moved: from === undefined,
      until: this.clock() + TIMINGS.guard,
      sticky,
      resends: 0,
      at: this.clock(),
    });
    if (sticky) {
      void this.saveMemory();
    }
  }

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.clock() >= Math.min(guard.until, guard.at + TIMINGS.guard)) {
      this.guards.delete(key);
      if (guard.sticky) {
        void this.saveMemory();
      }
      return false;
    }
    return Boolean(guard);
  }

  /** A read, through the guards: never lifted on an unknown value. */
  observe(account) {
    for (const [key, guard] of [...this.guards]) {
      if (!this.guardActive(key)) {
        continue;
      }
      const match = /^(\d+):([a-z0-9-]+)$/.exec(key);
      const deviceId = match ? Number(match[1]) : undefined;
      const entry = match ? account.data.get(deviceId) : undefined;
      const type = account.devices.get(deviceId)?.type;
      const code = type === undefined ? undefined : parameterOf(match[2], type);
      const value = code === undefined ? undefined : entry?.state.params.get(code)?.value;
      if (value === undefined) {
        continue;
      }
      if (!guard.moved && !same(value, guard.from)) {
        guard.moved = true;
      }
      if (guard.sticky) {
        if (!same(value, guard.expected)) {
          this.reaffirm(account, deviceId, code, guard);
        }
        continue;
      }
      if (guard.moved && same(value, guard.expected)) {
        this.guards.delete(key);
      }
    }
  }

  /** A sticky "Summer" read otherwise: written again, 3 times at most, never in a loop. */
  reaffirm(account, deviceId, code, guard) {
    if (guard.resends >= 3 || this.writing.has(deviceId) || !account.client.hasSession) {
      return;
    }
    guard.resends += 1;
    this.logger.warn(`Compit device ${deviceId}: "Summer" written again (${guard.resends}/3)`);
    this.write(account, deviceId, code, guard.expected, {
      beforeSend: () => {
        if (this.account !== account || this.guards.get(`${deviceId}:${F.SEASON}`) !== guard) {
          throw this.refusal(ERRORS.noAccount);
        }
      },
    })
      .then(() => this.followUp(account, deviceId, { quiet: false }))
      .catch((err) => {
        if (!err.beforeSend) {
          this.block(err);
          this.logger.warn(`Compit device ${deviceId}: "Summer" again failed (${reasonOf(err)})`);
          this.followUp(account, deviceId, { quiet: false });
        }
      });
  }
}
