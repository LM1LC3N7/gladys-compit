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
- [x] **Review 1 fixes** (2026-10-24, review r1 of 444f346): B1 "Summer"
      signs in by itself; I2 secondary 401 keeps the token; I3 no print of a
      good password; I4 per-device failures; I5 "Summer" waits for the
      departure only; I6 test button floor; I7 water heater; I8 docs; M1 to
      M8.
- [x] **Review 2 fixes** (2026-10-24, review r2 of 24c29ff): B1 periodic and
      follow-up reads on separate promises (a follow-up due during a periodic
      read is delayed, the timer always armed again); B2 renewals counted
      from 0 after any answer accepted with the token; I3 the sticky "Summer"
      guards reloaded at a restart get their follow-up reads whatever the
      wait; M1 status and Discovery during the wait after a restart; M2
      tokens never enumerable on errors; M3, M5 docs.
- [x] **Review 3** (approved): minors 1 (docs: the two cases where a
      reloaded sticky "Summer" is not checked) and 2 (status after a restart
      during a pause) fixed. Left: the other devices show "State not read"
      after the follow-up read of a restart until the periodic read
      (cosmetic, r3 minor 3); `fcm_token` empty (r3 minor 4, "To check").
- [x] **Review approval** (xhigh: heating, cloud account, undocumented API): r3.
- [ ] **Milestone 2 — real account**: run against a real iNext account (see
      "To check"); turn the answers (anonymized) into fixtures.

## To check on a real account

- The answer of `/authorize` to a wrong password (401 per the reference),
  whether 422 always means "client not registered", and whether a uid of our
  own (`gladys-compit-<16 hex>`) is accepted.
- The bodies: `/authorize` and `/clients` are sent as forms as the reference
  does (aiohttp `data=`); the reference sends `fcm_token=None` there (aiohttp
  turns None into the text "None" or refuses it); here an empty value.
- Whether iNext keeps one token per uid (two Gladys on one account now have
  their own uids; a shared uid could revoke each other's token).
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
  "HomeAssistant"; here label "Gladys" and a uid per installation
  (`gladys-compit-<16 hex>`, random, made once, kept in /data, review M5).
  No application key exists in this API; Node sends no User-Agent. Sign-in
  and registration as forms, like the reference (review M1).
- **Registration once per sign-in** (the reference recurses without end on
  422): a registration refused, a 422 without token or a second 422 is a
  refused account (reason `client`).
- **Refused account = final stop** (lot 12-13 lessons): 401/403 of
  `/authorize` (reason `login`), 400 (reason `request`, a neutral text: its
  cause cannot be told), a 401 right after a sign-in or after three renewals
  without a read (reason `token`), a refused registration (reason `client`).
  Persisted with a salted scrypt fingerprint, erased by the first success:
  of the e-mail and the password for `login` only; of the e-mail alone for
  the others, where the password may be good (review I3). No timer, no
  automatic retry; other credentials or a successful "Test the connection"
  lift it.
- **Token**: memory only (never in `/data`), sent as is in `Authorization`
  (as the reference). Dropped only by a 401 of `/gates`; a 401 elsewhere is
  confirmed on `/gates` once (review I2). Renewed by signing in again once
  per refusal, never two sign-ins within a minute (time persisted, saved
  before the sign-in leaves). Non-protective commands never sign in;
  "Summer" does (once, within its budget, joining a sign-in under way, also
  during a pause: review B1).
- **A 401/403 on one device state**: the token is confirmed on `/gates`
  (once per read); if the gates read, that device only, "access refused",
  spaced 15 min doubled up to 1 h, never a new sign-in (lesson 14 of lot 14);
  if the gates refuse it too, the normal renewal, and the device is read once
  more. A 404: the gates listed again.
- **One failing device** (5xx, timeout, bad answer): that device only, "not
  read", spaced one interval doubled up to 1 h, the values already read kept;
  only a 429, a failure of the gates or of every device is the account
  (review I4).
- **Never read sooner than the interval**: the time of the last read is kept
  in /data (before it leaves, at most once a minute), a restart waits for it
  (other credentials excepted); the test button reads only one interval after
  the last read (review I6, M6).
- **Features from the catalog** (`src/catalog.js`, a subset of the
  reference's `PARAMS`): only parameters with a clear meaning and a core unit.
  A feature appears once its parameter was read with a value. A device with
  an unknown type still shows its status and alarms.
- **Room setpoint** = `SET_TARGET_TEMPERATURE` (the manual setpoint, the one
  Home Assistant writes) of the Nano Color and Color 2, as
  `thermostat/target-temperature`; the setpoint in force
  (`TARGET_TEMPERATURE`) is a read-only temperature. On the Nano One
  (`__tzadman`, "R" in the definitions) a read-only temperature (review M7).
  Hot water = `DHW_TARGET_TEMPERATURE` as `water-heater/target-temperature`
  in whole degrees (review I7, as gladys-bsblan). Bounded by the
  configuration and by the `min`/`max` iNext gives, refused when the
  parameter is not `write: true`. Hot water ceiling `max_dhw`: 65 °C by
  default, 40–65 °C, never above 65 °C (Louis's rule of 2026-10-28, was
  55/60); the controller's lower `max` still wins.
- **Season** (`HVAC_MODE`, Nano One, Nano Color, Nano Color 2): `text/select`
  (never `thermostat/mode`, never a switch), 0 winter, 1 summer (heating off,
  Home Assistant's "off"), 2 cooling. "Cooling" is shown but never sent (a
  cooling start on a heating installation is not wanted from Gladys in v1).
- **"Summer" is protective**: it sets the season of the whole installation
  (heating and cooling off). No option, through a 429/5xx pause (one try),
  signs in by itself when no token is held, or after a 401 of its write that
  the gates confirm; waits only for the departure of a write of the device
  already leaving (never its answer, review I5), cancels non-protective
  commands of the device not sent yet (an epoch checked in `beforeSend`;
  their guard never replaces its own), written without a fresh read (never
  "already so"). After another write of the device that left less than 90 s
  before (or is still unanswered), its guard is sticky: kept in `/data`,
  lifted by time only (90 s), and a follow-up read showing otherwise writes
  "Summer" again, 3 times at most. A "Winter" really leaving (its
  `beforeSend`, called once by the transport, review M3) ends a sticky
  guard, saved at once.
- **Follow-up reads** (review M2): the commanded devices only, 5 s and 20 s
  after a command, grouped on one timer per account; never during a pause.
- **Stale controller**: `last_connected_at` older than 30 min compared with
  the `Date` header of iNext (never Gladys' clock; without either time, never
  stale): status says so, values not published, commands refused.
- **Commands one at a time per device** (lesson 1 of lot 14), 3 s between two
  writes of a device; a read begun before a write is dropped. A refusal says
  its cause: "last read failed", "not read yet", "signing in", "no session"
  (review M4).
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
