# gladys-compit

A [Gladys Assistant](https://gladysassistant.com) external integration for
**Compit** heating controllers (Nano One, Nano Color, Nano Color 2 room
thermostats; boiler, mixing valve, hot water, solar and heat pump
controllers) through the **iNext** cloud, with the e-mail address and the
password of the user's iNext account. Unofficial, not affiliated with Compit.

**Never tested with a real controller nor a real account**: the iNext API is
not documented publicly; this integration follows the library of Home
Assistant's Compit integration.

User guides: [English](docs/en.md), [français](docs/fr.md).

## How it works

- One Gladys device per Compit device of the account
  (`ext:<selector>:compit:<device id>`), read every 120 s by default: room,
  outdoor, boiler, hot water, mixing circuit, buffer, return and collector
  temperatures, humidity, fuel level, heating season, alarms, status.
- **Commands, each behind its own option, off by default**: the manual room
  setpoint (5 °C to a ceiling of 24 °C by default, 30 °C at most), the hot
  water setpoint (a water heater in whole degrees, 20 °C to a ceiling of
  65 °C by default, 65 °C at most), the
  season "Winter". Always within the bounds the controller gives. Decided on
  a fresh read, checked again right before the request leaves, refused after
  3.5 s, "sent, without confirmation" when the answer is missing.
- **"Summer" (heating and cooling of the whole installation off) is the
  protective command**: no option, written without a read, one try during a
  429/5xx pause, signs in by itself when needed, waits only for the
  departure of a previous write, cancels a command of the device not sent
  yet; sticky (written again 3 times at most) after another write that left
  just before. Its refusal cases are listed in the guides.
- **No switch, no writable binary**: a "turn everything off" never reaches the
  heating.
- **Account refused** (credentials, a fresh token, the registration of the
  client): a final stop kept in `/data`, never an automatic retry; other
  credentials or the "Test the connection" button try again, only a success
  lifts it. Never two sign-ins within a minute. 429/5xx: a bounded pause kept
  in `/data`. Nothing secret in logs, statuses or `/data`.
- On its first sign-in the integration registers itself as a client of the
  account under its own name ("Gladys", a uid of its own per installation),
  as the Home Assistant library does. No application key, no app identity, no User-Agent of an app.

## Credits

The iNext API, the shapes of its answers and the parameter codes of each
device type are ported from
[compit-inext-api](https://github.com/Przemko92/compit-inext-api)
(Przemko92, Apache-2.0, 0.9.2), the library of Home Assistant's Compit
integration. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Modelled on
the sibling integrations
[gladys-touchline-sl](https://github.com/LM1LC3N7/gladys-touchline-sl) (cloud
heating commands behind options),
[gladys-oekofen](https://github.com/LM1LC3N7/gladys-oekofen) and
[gladys-ta-cmi](https://github.com/LM1LC3N7/gladys-ta-cmi) (heating
controllers).

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

Tests never touch the network: iNext is a fake behind the injected HTTPS
transport (`test/fixtures/fakeCompit.js`), Gladys is the SDK's fake.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an Apache-2.0 project,
credited in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped
in the Docker image).
