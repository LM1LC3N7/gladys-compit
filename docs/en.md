# Compit for Gladys

Unofficial integration, not affiliated with Compit. It shows in Gladys the
Compit heating controllers of your iNext account (the cloud of the iNext app):
Nano One, Nano Color and Nano Color 2 room thermostats, boiler controllers
(BioMax, EL750, R470…), mixing valve controllers (R350.M, R350 T3, R810…), hot
water, solar and heat pump controllers (R480, R490, R 900).

**Never tested with a real controller nor a real account**: it follows the
compit-inext-api library (the one of Home Assistant's Compit integration); the
iNext API is not documented publicly. Please report any difference.

## What it does

One Gladys device per Compit device of the account, with, depending on the
model:

- room temperature, setpoint in force (read), manual setpoint;
- heating season (Winter, Summer = heating off, Cooling);
- outdoor, boiler, hot water, mixing circuit, buffer tank, return and solar
  collector temperatures;
- hot water setpoint, humidity, fuel level;
- alarms (the list iNext gives, or "No alarm") and status.

Values are read every 120 seconds by default (60 to 900 s). A controller that
has not reached the iNext cloud for over 30 minutes is shown in "Status", and
its old values are not published again.

## Installation

1. Install the integration from the Gladys store.
2. Enter the e-mail address and the password of your iNext account, then save.
   The password is kept by Gladys in its database, never shown again, and sent
   only to Compit (inext.compit.pl, over https).
3. Add the devices from the Discovery tab.

On its first sign-in, Gladys registers itself on the account as a new client
named "Gladys" (the iNext portal asks this of every client): the only write
made without a command of yours. No application key is used and Gladys never
poses as another application.

## Commands (off by default)

By default Gladys only reads. Three options, each off by default:

- **Room setpoint**: the manual setpoint of a Nano thermostat, from 5 °C to the
  chosen ceiling (24 °C by default, 16 to 30 °C, never above 30 °C), in steps
  of 0.1 °C.
- **Hot water setpoint**: from 20 °C to the chosen ceiling (55 °C by default,
  40 to 60 °C, never above 60 °C whatever is typed: scalding risk).
- **Season**: "Winter" (heating on). "Cooling" is never sent from Gladys in
  this version.

The bounds of the controller (the minimum and maximum iNext gives for the
parameter) apply too. No command is a switch: a "turn everything off" of a
voice assistant or a scene never reaches the heating.

A command (except "Summer") is decided on a fresh read of the device, right
before the write; it is refused, nothing sent, when its option is off (checked
again right before sending), when the value is out of bounds, when a value is
missing, when the controller says the parameter cannot be written, when it has
not reached the cloud for 30 minutes, when iNext is paused (busy or failing)
or answers too slowly, when another command of the same device is running, or
when "Summer" was asked meanwhile. A command that may have left without an
answer is reported "sent, without confirmation".

**"Summer" (heating off) needs no option** and goes through even during a
pause of iNext (one try). It is written without a read first. It is refused
only in these cases:

- no account configured, or the account was changed in the configuration
  while it was leaving;
- no session: a sign-in under way (one per minute at most) or a refused
  account;
- the type of the device is unknown (never listed by iNext) or has no season;
- a write of the same device already leaving does not end within 3.5 s;
- iNext is not reached in time ("not sent"), refuses the command ("refused")
  or does not answer ("sent, without confirmation").

It cancels a command of the same device not sent yet. If a "Winter" left just
before, "Summer" is written again (3 times at most, for 90 s) by the follow-up
reads that would show otherwise.

## Limits and safety

- Account refused (wrong e-mail or password, a token refused right after the
  sign-in, the registration of Gladys refused): a stop kept in /data, **no
  automatic retry**. Save other credentials, or press "Test the connection"
  (one try): only a success lifts the stop.
- Never two sign-ins within a minute, even after a restart.
- HTTP 429 or 5xx: a pause of 1 minute to 6 hours, kept in /data.
- A device iNext refuses (401/403) while the account reads: "Access refused",
  read again after 15 minutes then up to 1 hour, without a new sign-in.
- Nothing secret in the logs, /data or the statuses: /data keeps only a salted
  fingerprint of refused credentials, erased by the first success.
- Cooling, presets (holiday, away) and R 900 thermostats cannot be commanded in
  this version.

## Credits

Logic ported from [compit-inext-api](https://github.com/Przemko92/compit-inext-api)
(Apache-2.0, Przemko92), see `THIRD_PARTY_NOTICES.md`. Compit and iNext are
trademarks of their owner.
