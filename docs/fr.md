# Compit pour Gladys

Intégration non officielle, sans lien avec Compit. Elle affiche dans Gladys les
régulateurs de chauffage Compit de votre compte iNext (le cloud de l'application
iNext) : thermostats d'ambiance Nano One, Nano Color et Nano Color 2,
régulateurs de chaudière (BioMax, EL750, R470…), de vanne mélangeuse (R350.M,
R350 T3, R810…), d'eau chaude, solaires et de pompe à chaleur (R480, R490,
R 900).

**Jamais testé avec un vrai régulateur ni un vrai compte** : elle suit la
bibliothèque compit-inext-api (celle de l'intégration Compit de Home
Assistant), l'API iNext n'est pas documentée publiquement. Merci de signaler
tout écart.

## Ce qu'elle fait

Un appareil Gladys par appareil Compit du compte, avec, selon le modèle :

- température ambiante, consigne en cours (lue), consigne manuelle ;
- saison de l'installation (Hiver, Été = chauffage et rafraîchissement arrêtés, Rafraîchissement) ;
- températures extérieure, de la chaudière, de l'eau chaude, du circuit
  mélangé, du ballon tampon, de retour, du capteur solaire ;
- consigne de l'eau chaude, humidité, niveau de combustible ;
- alarmes (la liste que donne iNext, ou « Aucune alarme ») et état.

Les valeurs sont lues toutes les 120 secondes par défaut (de 60 à 900 s). Un
régulateur qui n'a pas joint le cloud iNext depuis plus de 30 minutes est
signalé dans « État », et ses anciennes valeurs ne sont pas republiées.

## Installation

1. Installez l'intégration depuis le store de Gladys.
2. Saisissez l'adresse e-mail et le mot de passe de votre compte iNext, puis
   enregistrez. Le mot de passe est gardé par Gladys dans sa base, jamais
   réaffiché, et envoyé seulement à Compit (inext.compit.pl, en https).
3. Ajoutez les appareils depuis l'onglet Découverte.

À sa première connexion, Gladys s'enregistre sur le compte comme un nouveau
client sous le nom « Gladys », avec un identifiant propre à votre installation
(comme le fait la bibliothèque de Home Assistant) : c'est l'unique écriture
faite sans commande de votre part. Aucune clé d'application n'est utilisée et
Gladys ne se fait passer pour aucune application. L'identifiant est gardé dans
/data : si /data ne pouvait pas être écrit, chaque redémarrage enregistrerait
un nouveau client « Gladys » ; les anciens se retirent dans l'appli iNext.

## Commandes (désactivées par défaut)

Par défaut Gladys ne fait que lire. Trois options, chacune désactivée par
défaut :

- **Consigne d'ambiance** : la consigne manuelle d'un thermostat Nano Color ou
  Nano Color 2, de 5 °C au plafond choisi (24 °C par défaut, de 16 à 30 °C,
  jamais plus de 30 °C), par pas de 0,1 °C. Sur le Nano One, la consigne est
  seulement lue.
- **Consigne d'eau chaude** : en degrés entiers, de 20 °C au plafond choisi
  (55 °C par défaut, de 40 à 60 °C, jamais plus de 60 °C quoi qu'on saisisse,
  risque de brûlure). Elle apparaît comme un chauffe-eau dans Gladys, jamais
  comme un thermostat d'ambiance.
- **Saison** : « Hiver » (chauffage en marche). « Rafraîchissement » n'est
  jamais envoyé depuis Gladys dans cette version.

Les bornes du régulateur (minimum et maximum que donne iNext pour le
paramètre) s'appliquent en plus. Aucune commande n'est un interrupteur
(switch) : un « éteins tout » d'un assistant vocal ou d'une scène n'atteint
jamais le chauffage.

Une commande (sauf « Été ») est décidée sur une lecture fraîche de l'appareil,
juste avant l'écriture ; elle est refusée sans rien envoyer si l'option est
désactivée (vérifiée aussi juste avant l'envoi), si la valeur sort des bornes,
si une valeur manque, si le régulateur dit le paramètre non modifiable, s'il
n'a pas joint le cloud depuis 30 minutes, si iNext est en pause (occupé ou en
panne), répond trop lentement ou refuse la lecture de l'appareil, si la
dernière lecture d'iNext a échoué ou si iNext n'a pas encore été lu (après un
redémarrage, jusqu'à un intervalle), s'il n'y a pas de session (ces commandes
ne se connectent jamais elles-mêmes), si une autre commande est en cours sur
le même appareil, ou si « Été » a été demandé entre-temps. Une commande qui a
pu partir sans réponse est annoncée « envoyée, sans confirmation ».

**« Été » n'a pas besoin d'option.** Il règle la saison de **toute
l'installation** du régulateur (pas d'une seule pièce) : il arrête le
chauffage, et aussi le rafraîchissement s'il était en cours. Il est écrit sans
lecture préalable, même pendant une pause d'iNext (un seul essai). S'il n'y a
pas de session (après un redémarrage pendant une pause, par exemple), il se
connecte lui-même une fois dans son délai, ou rejoint une connexion déjà en
cours ; si son écriture reçoit un 401, il vérifie le jeton sur la liste des
passerelles, le renouvelle si elle le refuse aussi, et écrit une seconde fois.
Il est refusé seulement dans ces cas :

- aucun compte configuré, ou le compte a été changé dans la configuration
  pendant l'envoi ;
- compte refusé (voir plus bas) ;
- pas de session, et une connexion est partie il y a moins d'une minute ;
- type de l'appareil inconnu (jamais listé par iNext) ou sans saison ;
- la connexion, ou une écriture du même appareil en train de partir, ne tient
  pas dans les 3,5 s (« trop lent ») ;
- la connexion échoue (iNext occupé, en panne ou injoignable) ;
- iNext n'est pas joint à temps (« non envoyée »), refuse la commande
  (« refusée ») ou ne répond pas (« envoyée, sans confirmation »).

Il annule une commande du même appareil pas encore envoyée, et n'attend
jamais la réponse d'une écriture précédente, seulement son départ. Si une
autre écriture du même appareil est partie juste avant lui (elle pourrait
arriver après), « Été » est réécrit (3 fois au plus, pendant 90 s) par les
lectures de suivi qui montreraient autre chose. La garde est gardée dans
/data : après un redémarrage dans ces 90 s, ses lectures de suivi continuent,
sauf dans deux cas où elles sont abandonnées sans nouvel essai : une connexion
partie moins d'une minute avant le redémarrage, ou une pause d'iNext (429/5xx)
en cours.

## Limites et sécurité

- Compte refusé (mauvais e-mail ou mot de passe, jeton refusé juste après la
  connexion, enregistrement de Gladys refusé, requête de connexion refusée en
  HTTP 400) : arrêt gardé dans /data, **aucun nouvel essai automatique**.
  Enregistrez d'autres identifiants, ou pressez « Tester la connexion » (un
  essai, pas plus souvent que l'intervalle) : seul un succès lève l'arrêt.
- Jamais deux connexions en moins d'une minute, même après un redémarrage ;
  la lecture périodique ne vient jamais plus tôt que l'intervalle après la
  précédente, même après un redémarrage ou avec le bouton « Tester la
  connexion » (les lectures de suivi après une commande, à 5 s et 20 s, et la
  vérification du jeton sur la liste des passerelles lisent plus tôt). Après un
  redémarrage dans l'intervalle, le statut dit quand vient la prochaine
  lecture (ou la fin d'une pause) ; un « Été » collant gardé dans /data est
  vérifié par ses lectures de suivi, sauf dans les deux cas cités plus haut.
- HTTP 429, ou une panne de toute la lecture : pause de 1 minute à 6 heures
  (429/5xx), gardée dans /data. Un appareil seul en panne (5xx, réponse
  illisible) est marqué « Non lu » et relu de plus en plus rarement (jusqu'à
  1 heure), les autres continuent.
- Un appareil dont iNext refuse l'accès (401/403) : le jeton est vérifié une
  fois sur la liste des passerelles ; si elle le lit, seul cet appareil est
  « Accès refusé », relu après 15 minutes puis jusqu'à 1 heure, sans nouvelle
  connexion ; si elle le refuse aussi, le jeton est renouvelé (une connexion).
- Rien de secret dans les journaux, /data ou les statuts. Tant que le compte
  est refusé, /data garde une empreinte salée : de l'e-mail et du mot de passe
  quand iNext les a refusés, de l'e-mail seul dans les autres cas ; effacée au
  premier succès.
- Rafraîchissement, préréglages (vacances, absence), consigne du Nano One et
  thermostats R 900 non commandables dans cette version.

## Crédits

Logique portée de [compit-inext-api](https://github.com/Przemko92/compit-inext-api)
(Apache-2.0, Przemko92), voir `THIRD_PARTY_NOTICES.md`. Compit et iNext sont des
marques de leur propriétaire.
