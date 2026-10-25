# Référentiel officiel de secours Géorisques — Isère

## Identité des communes et documents publics

`georisques_communes.json` reprend les 512 communes de l’API officielle de découpage administratif (`https://geo.api.gouv.fr/departements/38/communes?fields=nom,code,codesPostaux,centre&format=json`), récupérées le 25 octobre 2026. Les coordonnées sont des centres communaux, jamais une adresse ou une parcelle. Ces informations complètent les liens vers le formulaire communal Géorisques, avec `form-commune=true`, `type=municipality`, code INSEE, nom, code postal et centre connus. Les coordonnées inconnues restent absentes ; elles ne deviennent pas 0,0.

`georisques_documents.json` est un catalogue explicite par code INSEE de PDF publiés par les mairies. Les DICRIM de Saint-Paul-de-Varces, Beaurepaire (édition 2022) et Gières (édition 2026) ont répondu en HTTP 200 avec une signature PDF lors du contrôle du 25 octobre 2026. Les anciennes adresses de Gières, renvoyant 404, ont été écartées. Ce catalogue n’affirme ni une couverture exhaustive des communes ni que toutes les éditions sont les dernières applicables.

L’enrichissement ajoute également les fiches PPR lorsque les données établissent explicitement l’appartenance de la commune au plan, ainsi que le DDRM Isère 2020 et les fiches pratiques de la préfecture (portée départementale affichée). Un DICRIM recensé dans GASPAR sans lien PDF vérifié reste distinct d’un document téléchargeable. Le contrôle réseau peut être rejoué avec `scripts/check_georisques_documents.py`. Le site Géorisques étant inaccessible depuis l’environnement de développement lors du contrôle, ses formulaires et fiches ont été vérifiés sur leur structure et leurs paramètres, sans affirmation de disponibilité en navigation réelle.

`georisques_isere_reference.json` contient un extrait des données publiques officielles téléchargées et vérifiées le 24 octobre 2026. Il est inclus dans l’image backend pour fournir des données dès le démarrage, même si l’API principale ne répond pas. Le chargeur tente une actualisation quotidienne et conserve cet extrait si les serveurs de fichiers sont également indisponibles.

Sources et millésimes :

- GASPAR, ministère de la Transition écologique : export du 5 octobre 2026, https://files.georisques.fr/GASPAR/gaspar.zip. Risques DDRM, AZI, DICRIM, TIM et PPRN/PPRM/PPRT. Seules les communes ayant un code INSEE commençant par 38 sont conservées ; les plans sont regroupés par identifiant avec leurs communes et aléas.
- ASNR, potentiel radon par commune : fichier publié le 6 mai 2019, https://www.data.gouv.fr/datasets/connaitre-le-potentiel-radon-de-ma-commune. La date ancienne du référentiel reste affichée et aucun classement n’est extrapolé aux communes absentes.
- DDT de l’Isère, zonage sismique : https://www.data.gouv.fr/datasets/6863a7e83492920481cfef5b. 512 communes lues via le WFS officiel datacarto.open-datara.fr. La date de publication n’est pas précisée par la réponse WFS.
- BRGM, inventaires de mouvements de terrain et cavités : WFS https://mapsref.brgm.fr/wxs/georisques/risques, couches `MVT_LOCALISE` et `CAVITE_LOCALISEE`. 1 076 mouvements et 1 660 cavités localisés, lus sur toutes les pages avec tri stable. Les événements non localisés ne sont pas inclus. Les codes numériques de type et fiabilité sont conservés sans interprétation non vérifiée. La réponse ne fournit pas de millésime global.

Ces données publiques restent attribuées à leurs producteurs. GASPAR et les référentiels publiés sur data.gouv.fr sont diffusés sous Licence Ouverte. Le fichier n’est pas un bulletin d’alerte et ne constitue pas une collecte en temps réel.

Le script de contrôle `scripts/smoke_georisques.py --official-references` vérifie le frontend avec cet extrait réel et une API principale simulée en panne. Les tests des parseurs, de la pagination et du démarrage sans réseau sont dans `backend/tests/test_georisques_files.py`.
