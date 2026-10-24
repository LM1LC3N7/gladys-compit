# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Compit heating controllers
through the iNext cloud, with the user's account: a Node.js service (Node 22+,
ESM, no build step) that runs in its own sandboxed Docker container and talks
to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
`TODO.md` holds the status, the decisions and what comes next.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "Summer"  # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only
src/handlers.js                   SDK handlers -> CompitApp (shared with the tests)
src/app.js                        lifecycle, polling, errors, devices, badges, commands, guards
src/compit/client.js              the iNext API: sign-in, registration, token, reads, writes
src/compit/http.js                bounded HTTPS request, deadlines, beforeSend, no secret in errors
src/compit/errors.js              error codes
src/model.js                      the answers checked and reduced (pure)
src/catalog.js                    device type -> parameter code of each feature (pure)
src/devices.js                    devices and states for Gladys (pure)
src/config.js                     config_schema normalized (ceilings)
src/store.js                      /data: pause, refused account, last sign-in, sticky stops
src/publisher.js                  states within Gladys' limits
gladys-assistant-integration.json manifest
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys and a fake iNext
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever**: device `compit:<device id>`, features
  `room-temperature`, `room-target`, `setpoint`, `season`,
  `outdoor-temperature`, `boiler-temperature`, `dhw-temperature`,
  `dhw-setpoint`, `mixer-temperature`, `mixer2-temperature`,
  `buffer-temperature`, `return-temperature`, `collector-temperature`,
  `humidity`, `fuel-level`, `alarms`, `status`. A republished device never
  loses a feature (`keepCreatedFeatures`).
- Manifest keys (`email`, `password`, `allow_setpoints`, `max_setpoint`,
  `allow_dhw`, `max_dhw`, `allow_seasons`, `poll_interval`, `language`, the
  action `test_connection`) are frozen.
- **No switch, no writable binary.** Commands are the room setpoint
  (`thermostat/target-temperature`), the hot water setpoint
  (`water-heater/target-temperature`, whole degrees) and the `text/select`
  season of the installation, each behind its own option, off by default.
- **"Summer"** (heating and cooling of the whole installation off) needs no
  option, goes through a pause (one try), signs in by itself when needed,
  waits only for the departure of a previous write of the device (never its
  answer). Its exact refusal cases are listed in the docs: keep the code
  (`protect`, `sessionFor`) and the docs in sync.
- **Bounds**: room 5 °C to the ceiling (24 °C by default, 30 °C at most); hot
  water 20 °C to the ceiling (55 °C by default, 60 °C at most); always
  intersected with the bounds the controller gives.
- **Secrets**: the e-mail address, the password and the token never reach a
  log, a status, an error, `/data` (they live in private fields of the
  client). While the account is refused, `/data` holds a salted fingerprint
  of the e-mail and password (refused credentials) or of the e-mail only
  (other refusals): never a print of a password that may work.
  A secret field is "kept by Gladys in its database, never shown again",
  never said to be protected by a cipher.
- **No app identity**: the client registers as "Gladys" (a uid
  `gladys-compit-<16 hex>` per installation, kept in `/data`), never as
  another application, no application key, no User-Agent of an app.
- **A 401 on a secondary resource** (a device state, a fresh read, a write)
  never drops the token: the token is confirmed on `/gates`.
- **Failures**: a refused account is a final stop (no automatic retry); never
  two sign-ins within a minute; a failing device is that device only; 429, or
  every device failing, a bounded pause persisted; the periodic read never
  sooner than the interval (restart and test button included; follow-up
  reads after a command and the token check on `/gates` excepted); periodic
  and follow-up reads have their own promises and never drop each other;
  the renewal counter goes back to 0 on any answer accepted with the token;
  a reconnection to Gladys
  clears none of them.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set once by hand, see `TODO.md`).
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Files** are UTF-8 without BOM (`test/encoding.test.js`); invisible
  characters are written as escapes in the source, never as such.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
