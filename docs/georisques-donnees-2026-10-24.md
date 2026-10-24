# Géorisques : données et fiabilité

La page présente les inventaires des communes PCS suivies en Isère. Les totaux ne représentent pas le département entier et ne constituent pas une vigilance en temps réel.

## Données accessibles

- Risques naturels : potentiel radon, zonage sismique, mouvements de terrain (dates, lieux, type, fiabilité, référence), cavités (nom, type, repérage, référence).
- Prévention : risques GASPAR, atlas de zones inondables, TRI, PAPI, DICRIM et transmission d’information au maire (TIM).
- Plans de prévention naturels, miniers et technologiques : liste agrégée sur les communes suivies. Les DTO de liste PPR ne fournissent pas les communes de chaque plan : aucune attribution communale n’est inventée.
- CatNat : aperçu local et bouton de lecture de l’historique complet déjà collecté pour la commune.
- ICPE/Seveso : installations du référentiel déjà collecté, filtrées par code INSEE ou nom exact.
- Accès au rapport officiel de la commune et aux sources officielles.

## Corrections de collecte

Les paramètres v2 suivent OpenAPI (`codesInsee`, `pageSize`, `pageNumber` à partir de zéro). Le département n’est plus ajouté aux recherches par codes INSEE, notamment au zonage sismique qui n’accepte pas ce paramètre. Les réponses sont paginées avec une limite de 100 pages et un espacement des appels. Les erreurs d’authentification ne déclenchent plus douze essais de variantes de paramètres.

Chaque thème échoue indépendamment. Le fichier `georisques_detailed.json`, dans le répertoire de données existant, conserve les dernières données connues et leur date d’origine. Un changement de périmètre ne réutilise pas les anciens agrégats. Les données indisponibles restent nulles, affichées « — », au lieu d’un faux zéro.

Le zonage est demandé séparément pour chaque commune, car la réponse officielle n’inclut pas son code INSEE. La résolution géographique utilise `codeDepartement` et un nom exact normalisé.

L’API publique GASPAR est lue dans son format réel `risques_detail[].libelle_risque_long`, par lots de dix codes au maximum et avec une pagination commençant à un. Elle sert aussi de repli pour les risques recensés lorsque le flux v2 échoue ou n’a pas de jeton. Le nombre de familles de risques n’est plus traduit en niveau de danger. Les réponses de la route communale transmettent maintenant l’indisponibilité.

## Sources et vérification

- [Documentation officielle Géorisques](https://www.georisques.gouv.fr/doc-api)
- [Contrat OpenAPI v2](https://www.georisques.gouv.fr/api/v3/api-docs/georisques-api-v2)
- [Contrat OpenAPI v1](https://www.georisques.gouv.fr/api/v3/api-docs/georisques-api-v1)
- [Définition des procédures GASPAR](https://www.georisques.gouv.fr/donnees/bases-de-donnees/procedures-administratives-relatives-aux-risques)

Les tests unitaires couvrent notamment les erreurs partielles, le cache ancien, les codes INSEE, les schémas imbriqués, la pagination, les erreurs d’authentification et le repli public. `scripts/smoke_georisques.py` vérifie le vrai frontend sur des données de test locales, sur ordinateur et mobile.

Les appels réels vers Géorisques ont été interrompus avant réponse dans l’environnement de développement, aussi bien avec curl qu’avec urllib. L’API géographique des communes répond. Aucune disponibilité du flux Géorisques en production n’est donc affirmée. Le certificat TLS des appels authentifiés reste vérifié. Le jeton v2 existant et un redémarrage/déploiement du backend sont nécessaires pour utiliser les changements en production.
