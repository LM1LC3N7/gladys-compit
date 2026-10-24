# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Compit heating controllers through the iNext cloud with the user's account:
  one device per Compit device, with its temperatures (room, outdoor, boiler,
  hot water, mixing circuit, buffer, return, solar collector), humidity, fuel
  level, heating season, alarms and status.
- Optional commands, each off by default: the manual room setpoint (ceiling
  24 °C by default, 30 °C at most), the hot water setpoint (ceiling 55 °C by
  default, 60 °C at most), the season "Winter". "Summer" (heating off) is
  always allowed.
- A refused account is a final stop kept in `/data`, never retried on its own.
