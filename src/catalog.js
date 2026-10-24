// -----------------------------------------------------------------------------
// Which parameter of which Compit controller gives which feature: the device
// type code (`type` in the gate list, `Code` in compit-inext-api's device
// definitions) -> the parameter code of the iNext API.
//
// Ported from compit-inext-api 0.9.2 (Apache-2.0, Przemko92):
// `params_dictionary.py` (PARAMS) and `consts.py` (CompitDevice), only the
// parameters this integration publishes. The codes are those the iNext API
// answers in `GET /devices/{id}/state` (`params[].code`). A device type
// missing here still shows its status and its alarms.
// -----------------------------------------------------------------------------

import { FEATURES as F } from './constants.js';

/** The device models compit-inext-api knows (CompitDevice): type code -> name. */
export const MODELS = {
  0: 'SPM - Nano Color2',
  3: 'R810',
  5: 'R350 T3',
  7: 'Nano One',
  12: 'Nano Color',
  14: 'BWC310',
  17: 'L2',
  27: 'SHC',
  34: 'r470',
  36: 'BioMax742',
  44: 'SolarComp 951',
  45: 'SolarComp971',
  53: 'R350.CWU',
  75: 'BioMax772',
  78: 'SPM - Nano Color2',
  91: 'R770RS / R771RS',
  92: 'r490',
  201: 'BioMax775',
  210: 'EL750',
  212: 'BioMax742',
  215: 'R480',
  221: 'R350.M',
  222: 'R810',
  223: 'Nano Color 2',
  224: 'R 900',
  225: 'SPM - Nano Color',
  226: 'AF-1',
  227: 'COMBO',
  229: 'COMBO PRO',
};

/** role -> { type code -> parameter code }. */
export const PARAMETERS = {
  // CURRENT_TEMPERATURE
  [F.ROOM_TEMPERATURE]: { 7: '__t_pokojowa', 12: '__tpokojowa', 223: '__tpokojowa' },
  // TARGET_TEMPERATURE: the setpoint in force (program, manual, away...), read
  // only. On the Nano One it is `__tzadman`, which the device definitions of
  // the reference give as read only ("R"): published as a sensor there.
  [F.ROOM_TARGET]: { 7: '__tzadman', 12: '__tpokzadana', 223: '__tpokzadana' },
  // SET_TARGET_TEMPERATURE: the manual setpoint, the one Home Assistant
  // writes (read/write in the definitions of the Nano Color and Color 2).
  [F.SETPOINT]: { 12: '__tempzadpracareczna', 223: '__tempzadpracareczna' },
  // OUTDOOR_TEMPERATURE
  [F.OUTDOOR]: {
    3: '__tzewn',
    5: '__t_ext',
    12: '__rd_tempzewn',
    27: '__rr_temp',
    34: '__t_ext',
    36: '__t_ext',
    53: '__t_zewn',
    75: '__tempzewn',
    78: '__temp',
    91: '__tzewn',
    201: '__Tzew',
    212: '__t_zewn',
    221: '__rt_t_zew',
    223: '__rd_tempzewn',
    224: '__t_ext',
    225: '__pom_temp',
    226: '__rr_tzew',
  },
  // BOILER_TEMPERATURE
  [F.BOILER]: {
    36: '__t_boiler',
    75: '__t_boiler',
    91: '__ramkatkotla',
    201: '__t_boiler',
    210: '__tkotla',
    212: '__tkotla',
  },
  // DHW_CURRENT_TEMPERATURE, and DHW_TEMPERATURE of the EL750 (same code).
  [F.DHW_TEMPERATURE]: {
    34: '__t_cwu',
    36: '__t_cwu',
    53: '__tcwuzmierz',
    75: '__t_cwu',
    91: '__tcwu',
    92: '__tempcw',
    201: '__t_cwu',
    210: '__tcwu',
    215: '__rr_t_cwu',
    224: '__rr_temp_zmier_cwu',
  },
  // DHW_TARGET_TEMPERATURE
  [F.DHW_SETPOINT]: {
    34: '__tcwuzad',
    36: '__tzadcwu',
    44: '__tempzadzassol',
    45: '__tzadcwu',
    53: '__temp_zad',
    75: '__tzadcwu',
    91: '__zadtempcwu',
    92: '__cwutempzadpreczna',
    99: '__tzadcwu',
    201: '__tzadcwu',
    210: '__tcwuzadana',
    212: '__temp_zad_Cwu',
    215: '__rr_t_zad_cwu',
    222: '__cwu_temp_zada',
    224: '__temp_zada_prac_cwu',
  },
  // MIXER_TEMPERATURE, and MIXER1_TEMPERATURE of the R770RS.
  [F.MIXER]: { 5: '__tmieszacza', 91: '__ramkatempco1', 221: '__rr_t_mie' },
  // MIXER2_TEMPERATURE
  [F.MIXER2]: { 91: '__ramkatempco2' },
  // ACTUAL_BUFFER_TEMP
  [F.BUFFER]: { 215: '__rr_t_buf', 224: '__rr_temp_zmie_bufo' },
  // RETURN_CIRCUIT_TEMPERATURE, and BUFFER_RETURN_TEMPERATURE of the EL750.
  [F.RETURN]: { 3: '__temppowrotu', 210: '__tpowrotu', 226: '__rr__tpow' },
  // COLLECTOR_TEMPERATURE
  [F.COLLECTOR]: { 44: '__tkolektora', 45: '__tkol', 99: '__tkol' },
  // HUMIDITY
  [F.HUMIDITY]: { 27: '__rr_wilgotnosc', 78: '__hig', 225: '__pom_hum' },
  // FUEL_LEVEL
  [F.FUEL]: {
    36: '__fuel',
    75: '__fuel',
    91: '__poziompaliwa',
    201: '__fuel',
    212: '__poz_paliwa',
  },
  // HVAC_MODE: 0 winter, 1 summer (heating off), 2 cooling (device definitions
  // of the three thermostats). The R 900 uses the same code with values not
  // listed in the definitions: left out.
  [F.SEASON]: { 7: '__mode_intal', 12: '__trybpracyinstalacji', 223: '__trybpracyinstalacji' },
};

/** ALARM_CODE of the AF-1: shown with the alarms. */
export const ALARM_CODE = { 226: '__kod_alarmu' };

/** The parameter code of a role for a device type, else undefined. */
export function parameterOf(role, type) {
  const table = PARAMETERS[role];
  return table && Object.hasOwn(table, type) ? table[type] : undefined;
}

/** The roles a device type may give (whatever its state holds). */
export function rolesOfType(type) {
  return Object.keys(PARAMETERS).filter((role) => parameterOf(role, type) !== undefined);
}

export const modelOf = (type) =>
  Object.hasOwn(MODELS, type) ? `Compit ${MODELS[type]}` : `Compit (type ${type})`;
