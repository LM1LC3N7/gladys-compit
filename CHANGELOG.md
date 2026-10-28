# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Changed

- Hot water ceiling raised to 65 °C (default 65 °C), device limits still apply.

## [0.1.1] - 2026-10-24

### Added

- Compit heating controllers through the iNext cloud with the user's account:
  one device per Compit device, with its temperatures (room, outdoor, boiler,
  hot water, mixing circuit, buffer, return, solar collector), humidity, fuel
  level, season of the installation, alarms and status.
- Optional commands, each off by default: the manual room setpoint of the Nano
  Color thermostats (ceiling 24 °C by default, 30 °C at most), the hot water
  setpoint as a water heater in whole degrees (ceiling 55 °C by default, 60 °C
  at most), the season "Winter". "Summer" (heating and cooling of the whole
  installation off) needs no option and signs in by itself when needed; the
  guide lists the cases where it is still refused.
- A refused account is a final stop kept in `/data`, never retried on its own.
- A token that expires often never ends in a false "account refused"; the
  periodic read never stops after a follow-up read.
- One failing device never stops the others; a refused device never signs in
  again; a restart or the test button never reads sooner than the interval.

[Unreleased]: https://github.com/LM1LC3N7/gladys-compit/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-compit/releases/tag/v0.1.1
