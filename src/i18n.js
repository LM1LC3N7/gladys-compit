// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature names, the status of the
// integration, the answers of the button and the command errors. None of
// them ever carries the e-mail address, the password or the token.
// -----------------------------------------------------------------------------

import { FEATURES as F } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

const join = (...parts) => both(parts.map((p) => p.en).join(' '), parts.map((p) => p.fr).join(' '));

/** The name of the device of a Compit controller. */
export const deviceName = (label, model, id) => {
  const name = label || model || `Compit ${id}`;
  return both(`${name} (Compit)`, `${name} (Compit)`);
};

export const FEATURE_NAMES = {
  [F.ROOM_TEMPERATURE]: both('Room temperature', 'Température ambiante'),
  [F.ROOM_TARGET]: both('Setpoint in force', 'Consigne en cours'),
  [F.SETPOINT]: both('Manual setpoint', 'Consigne manuelle'),
  [F.OUTDOOR]: both('Outdoor temperature', 'Température extérieure'),
  [F.BOILER]: both('Boiler temperature', 'Température de la chaudière'),
  [F.DHW_TEMPERATURE]: both('Hot water temperature', 'Température de l’eau chaude'),
  [F.DHW_SETPOINT]: both('Hot water setpoint', 'Consigne de l’eau chaude'),
  [F.MIXER]: both('Mixing circuit temperature', 'Température du circuit mélangé'),
  [F.MIXER2]: both('Mixing circuit 2 temperature', 'Température du circuit mélangé 2'),
  [F.BUFFER]: both('Buffer tank temperature', 'Température du ballon tampon'),
  [F.RETURN]: both('Return temperature', 'Température de retour'),
  [F.COLLECTOR]: both('Solar collector temperature', 'Température du capteur solaire'),
  [F.HUMIDITY]: both('Humidity', 'Humidité'),
  [F.FUEL]: both('Fuel level', 'Niveau de combustible'),
  [F.SEASON]: both('Heating season', 'Saison de chauffage'),
  [F.ALARMS]: both('Alarms', 'Alarmes'),
  [F.STATUS]: both('Status', 'État'),
};

export const SEASON_NAMES = {
  winter: both('Winter (heating)', 'Hiver (chauffage)'),
  summer: both('Summer (heating off)', 'Été (chauffage arrêté)'),
  cooling: both('Cooling', 'Rafraîchissement'),
};

export const STATUS_TEXTS = {
  online: both('OK', 'OK'),
  stale: both(
    'The controller has not reached the iNext cloud for over 30 min',
    'Le régulateur n’a pas joint le cloud iNext depuis plus de 30 min',
  ),
  denied: both('Access to this device refused', 'Accès à cet appareil refusé'),
  offline: both('Compit iNext unreachable', 'Compit iNext injoignable'),
  gone: both('Device not found on the account', 'Appareil introuvable sur le compte'),
  unknown: both('State not read', 'État non lu'),
};

export const ALARM_TEXTS = {
  none: both('No alarm', 'Aucune alarme'),
  list: (items) => both(items.join('; '), items.join(' ; ')),
};

const PROBLEMS = {
  empty: both(
    'Enter the e-mail address and the password of your Compit iNext account, then save.',
    'Saisissez l’adresse e-mail et le mot de passe de votre compte Compit iNext, puis enregistrez.',
  ),
  noEmail: both(
    'Enter the e-mail address of your iNext account.',
    'Saisissez l’adresse e-mail de votre compte iNext.',
  ),
  badEmail: both('This e-mail address is not valid.', 'Cette adresse e-mail n’est pas valide.'),
  noPassword: both(
    'Enter the password of your iNext account.',
    'Saisissez le mot de passe de votre compte iNext.',
  ),
  badPassword: both('This password is too long.', 'Ce mot de passe est trop long.'),
};

const REFUSALS = {
  login: both(
    'Compit refused the e-mail address or the password.',
    'Compit a refusé l’adresse e-mail ou le mot de passe.',
  ),
  token: both(
    'Compit refused the connection right after the sign-in.',
    'Compit a refusé la connexion juste après l’identification.',
  ),
  client: both(
    'Compit did not accept the registration of Gladys on the account.',
    'Compit n’a pas accepté l’enregistrement de Gladys sur le compte.',
  ),
};

/** The integration status, the button and the logs a user may read. */
export const T = {
  problem: (key) => PROBLEMS[key] ?? PROBLEMS.empty,
  connecting: both('Connecting to Compit iNext…', 'Connexion à Compit iNext…'),
  connected: (gates, devices) =>
    both(
      `Connected: ${gates} iNext module(s), ${devices} device(s).`,
      `Connecté : ${gates} module(s) iNext, ${devices} appareil(s).`,
    ),
  noDevice: both(
    'Connected, but the account holds no Compit device.',
    'Connecté, mais le compte ne contient aucun appareil Compit.',
  ),
  refused: (reason) =>
    join(
      REFUSALS[reason] ?? REFUSALS.login,
      both(
        'Stopped: no new try on its own. Save other credentials, or press "Test the connection" to try once.',
        'Arrêt : aucun nouvel essai automatique. Enregistrez d’autres identifiants, ou pressez « Tester la connexion » pour essayer une fois.',
      ),
    ),
  busy: (wait) =>
    both(
      `Compit iNext is busy or failing: paused for ${wait.en}.`,
      `Compit iNext est occupé ou en panne : pause de ${wait.fr}.`,
    ),
  signInWait: (wait) =>
    both(
      `Signing in again in ${wait.en} (at most one sign-in per minute).`,
      `Nouvelle connexion dans ${wait.fr} (une connexion par minute au plus).`,
    ),
  unreachable: (reason, wait) =>
    both(
      `Compit iNext unreachable (${reason}): next try in ${wait.en}.`,
      `Compit iNext injoignable (${reason}) : nouvel essai dans ${wait.fr}.`,
    ),
  denied: (count) =>
    both(` Access refused to ${count} device(s).`, ` Accès refusé à ${count} appareil(s).`),
  test: {
    cooldown: both('Tested less than 10 s ago.', 'Testé il y a moins de 10 s.'),
  },
  join,
};

/** The errors of the commands, shown by Gladys when a command fails. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  setpointsDisabled: both(
    'Room setpoint commands are off: allow them in the configuration of the integration.',
    'Les commandes de consigne d’ambiance sont désactivées : autorisez-les dans la configuration de l’intégration.',
  ),
  dhwDisabled: both(
    'Hot water setpoint commands are off: allow them in the configuration of the integration.',
    'Les commandes de consigne d’eau chaude sont désactivées : autorisez-les dans la configuration de l’intégration.',
  ),
  seasonsDisabled: both(
    'Season changes are off (only "Summer" is always allowed): allow them in the configuration of the integration.',
    'Les changements de saison sont désactivés (seul « Été » est toujours permis) : autorisez-les dans la configuration de l’intégration.',
  ),
  badNumber: both('Not a temperature.', 'Ce n’est pas une température.'),
  badStep: both('Use steps of 0.1 °C.', 'Utilisez des pas de 0,1 °C.'),
  outOfRange: (min, max) =>
    both(
      `Setpoint refused: from ${min} to ${max} °C only.`,
      `Consigne refusée : de ${min} à ${max} °C seulement.`,
    ),
  noRange: both(
    'The bounds of the controller and those of the integration do not overlap: command not sent.',
    'Les bornes du régulateur et celles de l’intégration ne se recouvrent pas : commande non envoyée.',
  ),
  badSeason: both('Unknown season.', 'Saison inconnue.'),
  cooling: both(
    'Cooling cannot be chosen from Gladys in this version: command not sent.',
    'Le rafraîchissement ne peut pas être choisi depuis Gladys dans cette version : commande non envoyée.',
  ),
  stillRunning: both(
    'Another command is still running on this device: try again in a few seconds.',
    'Une autre commande est en cours sur cet appareil : réessayez dans quelques secondes.',
  ),
  stopped: both(
    '"Summer" (heating off) was asked meanwhile: command not sent.',
    '« Été » (chauffage arrêté) a été demandé entre-temps : commande non envoyée.',
  ),
  paused: both(
    'Compit iNext is paused (busy or failing): command not sent.',
    'Compit iNext est en pause (occupé ou en panne) : commande non envoyée.',
  ),
  refusedAccount: both(
    'The account was refused (see the configuration): command not sent.',
    'Le compte a été refusé (voir la configuration) : commande non envoyée.',
  ),
  unknownDevice: both(
    'This device is not known now: command not sent.',
    'Cet appareil n’est pas connu pour l’instant : commande non envoyée.',
  ),
  noSession: both(
    'Signing in to Compit again: command not sent, try again in a minute.',
    'Reconnexion à Compit en cours : commande non envoyée, réessayez dans une minute.',
  ),
  tooSlow: both(
    'Compit answers too slowly: command not sent.',
    'Compit répond trop lentement : commande non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The current state could not be read (${reason}): command not sent.`,
      `L’état actuel n’a pas pu être lu (${reason}) : commande non envoyée.`,
    ),
  missingValue: both(
    'A value needed to decide is missing: command not sent.',
    'Une valeur nécessaire pour décider manque : commande non envoyée.',
  ),
  notWritable: both(
    'The controller does not allow this parameter to be written: command not sent.',
    'Le régulateur ne permet pas d’écrire ce paramètre : commande non envoyée.',
  ),
  stale: both(
    'The controller has not reached the iNext cloud for over 30 min: command not sent.',
    'Le régulateur n’a pas joint le cloud iNext depuis plus de 30 min : commande non envoyée.',
  ),
  notSent: (reason) => both(`Command not sent (${reason}).`, `Commande non envoyée (${reason}).`),
  refused: (reason) =>
    both(`Compit refused the command (${reason}).`, `Compit a refusé la commande (${reason}).`),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the device in a moment.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l’appareil dans un instant.`,
    ),
};
