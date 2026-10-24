# TODO — Compit v1

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Status

- [x] **Milestone 1 — read, bounded commands** (2026-10-24): iNext sign-in
      with the registration of the client, gates, device states, one device
      per Compit device, temperatures, humidity, fuel level, season, alarms,
      status, stale controller, room and hot water setpoints and season
      behind options, "Summer" protective, refused account stop, 429/5xx
      pause, en/fr, docs, cover. Tested against a fake iNext only (Node 22
      and 24).
- [ ] **Review** (xhigh: heating, cloud account, undocumented API).
- [ ] **Milestone 2 — real account**: run against a real iNext account (see
      "To check"); turn the answers (anonymized) into fixtures.

## To check on a real account

- The answer of `/authorize` to a wrong password (401 per the reference),
  whether 422 always means "client not registered", and whether the uid
  `gladys-compit` is accepted (the reference uses a fixed uid too).
- The lifetime of the token and the answer to an expired one (401 assumed).
- The `Date` header of iNext and the format of `last_connected_at` (ISO
  assumed); the shape of `errors` (texts or objects, read both).
- Whether a written setpoint shows in the state at once (confirmation by the
  follow-up reads at 5 s and 20 s) and the step the thermostats accept (0.1 °C
  allowed here; the Nano may round to 0.5 °C).
- The season values of the R 900 (`__trybpracyinstalacji`, left out).
- Whether `PUT /params` answers 2xx for a value the controller refuses.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-compit:0.1.0`):
  the first patch release gives 0.1.1.
- **Not a duplicate**: line 3 of `_lots/lot15/proposition.md` (free in the
  tracker, no `gladys-compit` elsewhere); the reservation checks are the main
  session's.
- **Reference**: compit-inext-api 0.9.2 (Apache-2.0, Przemko92), the library
  of Home Assistant's Compit integration, read at commit 4acb320 in
  `~/code/ref/lot15/compit-inext-api` (license checked in its `LICENSE`:
  Apache-2.0, no holder named, no `NOTICE`). Ported, not copied; credited in
  `THIRD_PARTY_NOTICES.md`, shipped in the image.
- **Neighbours**: gladys-oekofen and gladys-ta-cmi (heating controllers, read
  only) for the shape; gladys-touchline-sl (cloud heating with commands behind
  options: client, transport, guards, publisher) for the structure, read
  only, nothing changed in them.
- **No app identity**: the reference registers its client as
  "HomeAssistant"; here uid `gladys-compit`, label "Gladys". No application
  key exists in this API; Node sends no User-Agent.
- **Registration once per sign-in** (the reference recurses without end on
  422): a registration refused, a 422 without token or a second 422 is a
  refused account (reason `client`).
- **Refused account = final stop** (lot 12-13 lessons): 400/401/403 of
  `/authorize`, a 401 right after a sign-in or after three renewals without a
  read (reason `token`), a refused registration (reason `client`). Persisted
  with a salted scrypt fingerprint of the refused e-mail and password (erased
  by the first success); no timer, no automatic retry; other credentials (at
  once, or at the next start if changed while stopped) or a successful
  "Test the connection" lift it.
- **Token**: memory only (never in `/data`), sent as is in `Authorization`
  (as the reference), renewed by signing in again once per refusal, never two
  sign-ins within a minute (time persisted, saved before the sign-in leaves).
  Commands never sign in.
- **A 401/403 on one device state** while the gates read: that device only,
  "access refused", spaced 15 min doubled up to 1 h, never a new sign-in
  (lesson 14 of lot 14). A 404: the gates listed again.
- **Features from the catalog** (`src/catalog.js`, a subset of the
  reference's `PARAMS`): only parameters with a clear meaning and a core unit.
  A feature appears once its parameter was read with a value. A device with
  an unknown type still shows its status and alarms.
- **Room setpoint** = `SET_TARGET_TEMPERATURE` (the manual setpoint, the one
  Home Assistant writes); the setpoint in force (`TARGET_TEMPERATURE`) is a
  read-only temperature. Hot water = `DHW_TARGET_TEMPERATURE`. Both
  `thermostat/target-temperature`, bounded by the configuration and by the
  `min`/`max` iNext gives, refused when the parameter is not `write: true`.
- **Season** (`HVAC_MODE`, Nano One, Nano Color, Nano Color 2): `text/select`
  (never `thermostat/mode`, never a switch), 0 winter, 1 summer (heating off,
  Home Assistant's "off"), 2 cooling. "Cooling" is shown but never sent (a
  cooling start on a heating installation is not wanted from Gladys in v1).
- **"Summer" is protective**: no option, through a 429/5xx pause (one try),
  never waits for another command except a write already leaving (bounded by
  the 3.5 s budget), cancels non-protective commands of the device not sent
  yet (an epoch checked in `beforeSend`), written without a fresh read (it
  always writes, never "already so"). After a "Winter" written less than 90 s
  before, its guard is sticky: kept in `/data`, lifted by time only (90 s),
  and a follow-up read showing otherwise writes "Summer" again, 3 times at
  most. A "Winter" really leaving (its `beforeSend`) ends a sticky guard.
- **Stale controller**: `last_connected_at` older than 30 min compared with
  the `Date` header of iNext (never Gladys' clock; without either time, never
  stale): status says so, values not published, commands refused.
- **Commands one at a time per device** (lesson 1 of lot 14), 3 s between two
  writes of a device; follow-up reads at 5 s and 20 s; a read begun before a
  write is dropped.
- **No energy feature**: the energy parameters of a few models (solar,
  R350.CWU) are daily or thermal counters whose meaning is not documented.
- **No presets** (holiday, away, party): their writes need two parameters on
  the Nano Color (out-of-home first); left for a v2.
- **Polling 120 s by default** (60 to 900 s): one request per device per
  poll, plus the gates every 6 h.
- **Alarm texts**: the `errors` list of the state (its shape is not
  documented: texts, or objects with a label, a description, a code), five
  shown, the others counted; the alarm code of an AF-1 when not 0.

## Next

- Presets of the Nano thermostats (auto, holiday, manual, away), with the
  away parameter written first, behind their own option.
- Hot water mode (off / on / schedule) as a select, "off" protective.
- R 900 season, once its values are known.
