# ANFR — antennes des réseaux mobiles en Isère

Le service `anfr_isere` utilise l'[observatoire officiel des réseaux mobiles ANFR](https://data.anfr.fr/visualisation/information/?id=observatoire_2g_3g_4g).
Il recense les supports uniques et les stations mobiles associés, les opérateurs,
les générations publiées et les coordonnées disponibles. Les générations indiquées
décrivent les installations recensées ; elles ne confirment ni la couverture à une
adresse ni le fonctionnement actuel d'une antenne. Les indisponibilités mobiles
relèvent du service ARCEP distinct.

## Collecte départementale

Le collecteur `backend/app/anfr_sources.py` interroge l'[API D4C de l'ANFR](https://data.anfr.fr/d4c/api/records/1.0/search/?dataset=observatoire_2g_3g_4g&refine.sta_nm_dpt=038&rows=1)
avec `dataset=observatoire_2g_3g_4g` et `refine.sta_nm_dpt=038`. La collecte cible
l'Isère et remplace le téléchargement de l'archive nationale de toutes les
installations radioélectriques.

Les pages sont triées par `id`, avec au plus 4 000 lignes par requête et un décalage
`start` augmenté du nombre de lignes effectivement reçu. Le collecteur vérifie
le département de chaque ligne, les identifiants, les doublons, la stabilité du
total annoncé et la réception de toutes les pages. Les supports et les stations
sont comptés par identifiant unique ; plusieurs lignes peuvent décrire un même
support. Un support sans coordonnées valides reste inclus dans le total, même
s'il ne peut pas être placé sur la carte.

La collecte est bornée à 40 pages, 50 000 lignes, 2 Mio par page et 60 secondes
au total, avec un délai réseau maximal de 12 secondes par appel. Un incident
réseau transitoire peut déclencher une seconde tentative de la page dans ce même
budget. Une réponse tronquée, incohérente ou dépassant ces limites n'est jamais
publiée comme une collecte complète.

## Dates et conservation

| Champ | Signification |
| --- | --- |
| `resource_updated_at`, `published_at` | Date de mise à jour publiée dans les données ANFR, lorsqu'elle est disponible. |
| `updated_at`, `last_success_at` | Date de la dernière collecte complète réussie par l'application. |
| `last_attempt_at` | Date de la dernière tentative de collecte, même si elle a échoué. |
| `meta.next_retry_at` | Prochaine tentative prévue après un échec. |

Seule une collecte complète et validée reçoit `status: online` et `complete: true`.
En cas d'échec, les dernières bonnes données restent disponibles avec leur date
de collecte d'origine, `status: stale`, `complete: false` et
`retained_previous: true`. Leur date n'est pas renouvelée par une erreur réseau.

Sans données fiables précédentes, le statut est `unavailable`, les comptages sont
`null` et `updated_at` est `null`. Une panne ne signifie pas zéro antenne : seul un
résultat complet effectivement vide peut confirmer un zéro. Les anciens snapshots
avec des comptages positifs et datés sont conservés comme historiques non vérifiés
(`legacy_unverified`), tandis que les anciens faux zéros issus d'erreurs sont
écartés. Les erreurs techniques brutes ne sont pas affichées.

## Cache et actualisation

Le cache ANFR utilise le schéma 3 et la clé `anfr_isere_v3`. Seuls les résultats
complets et validés sont enregistrés comme bonnes données, en mémoire et dans
Redis avec une copie persistante. La durée normale du cache est de 12 heures ;
les lectures ne rajeunissent pas la date des données.

L'ordonnanceur effectue une nouvelle collecte toutes les 6 heures après un succès.
Après des échecs successifs, il programme les tentatives après 60, 180, 300 puis
900 secondes ; le dernier délai reste appliqué tant que la source échoue. Une
réussite remet le compteur à zéro et rétablit la cadence de 6 heures. Une seule
tâche ANFR de l'ordonnanceur reste en attente ou en cours par worker ; les verrous
Redis évitent les téléchargements simultanés entre workers.

Les tests `backend/tests/test_anfr_sources.py`, `test_anfr_cache.py` et
`test_anfr_scheduler.py` couvrent la pagination, les limites, les erreurs, les
dates, les caches anciens et les reprises automatiques. Les contrôles d'affichage
sont dans `tests/anfr.test.cjs`. Le scénario navigateur `scripts/smoke_anfr.py`
vérifie aussi la récupération après erreur sur ordinateur et mobile, avec une
API de test locale et, en option, une collecte réelle sauvegardée via `--payload`.
