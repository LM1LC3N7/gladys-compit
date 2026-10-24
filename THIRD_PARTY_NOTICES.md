# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## compit-inext-api

<https://github.com/Przemko92/compit-inext-api> (package `compit-inext-api`,
the library of Home Assistant's Compit integration), by Przemko92 (Przemyslaw
Grzywa, as named in its `pyproject.toml`) and contributors. Apache License 2.0
(`LICENSE` of the repository, version 0.9.2 of 2026-10-02, read at commit
4acb320). The repository has no `NOTICE` file and its `LICENSE` names no
copyright holder. The full text of the Apache License 2.0 is the `LICENSE`
file of this integration (the same text). As the reference has no notice of
its own, this notice was written for this port:

```
compit-inext-api, Copyright Przemko92 and contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

What was ported, and how it was changed:

- `api.py`: the endpoints of the iNext API (`/authorize`, `/clients`,
  `/gates`, `/devices/{id}/state`, `/devices/{id}/params`) and the shape of
  their bodies (`src/compit/client.js`), forms for the sign-in and the
  registration as the reference sends them. Changed: the client registers
  under its own name ("Gladys", a uid per installation) instead of
  "HomeAssistant";
  the registration is tried once per sign-in (the original retries without
  end); a refused account is a final stop; token renewal bounded; answers
  bounded in size and parsed without prototype keys; deadlines on writes.
- `types/SystemInfo.py`, `types/DeviceState.py`: the fields read from the
  gates and from a device state (`src/model.js`), with strict checks.
- `params_dictionary.py` (`PARAMS`) and `consts.py` (`CompitDevice`): the
  parameter codes of each device type for the published features and the
  names of the models (`src/catalog.js`), a subset only.
- `consts.py` (`CompitHVACMode`) and the device definitions of the Nano
  thermostats: the values of the heating season (0 winter, 1 summer,
  2 cooling).
