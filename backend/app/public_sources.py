"""Five public feeds collected by the scheduler, never by page navigation.

Provider URLs are fixed. Small persistent snapshots survive Redis eviction;
the complete CatNat history stays on disk and is read on demand by commune.
"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import gzip
import io
import json
import math
from pathlib import Path
import re
import tempfile
from time import monotonic
import unicodedata
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


ECONOMY = "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/"
FUEL_DATASET = "prix-des-carburants-en-france-flux-instantane-v2"
RECALL_DATASET = "rappelconso-v2-gtin-espaces"
ENERGY_API = "https://odre.opendatasoft.com/api/explore/v2.1/catalog/datasets/eco2mix-regional-tr/records"
ONDE_API = "https://hubeau.eaufrance.fr/api/v1/ecoulement/observations"
CATNAT_API = "https://www.georisques.gouv.fr/api/v1/gaspar/catnat"
COMMUNES_API = "https://geo.api.gouv.fr/departements/38/communes"
MAX_BYTES = 8 * 1024 * 1024
DEFINITIONS = {
    "fuel_isere": {"label": "Stations-service · Isère", "interval": 600,
        "source": "https://www.prix-carburants.gouv.fr/rubrique/opendata/",
        "note": "Prix et ruptures déclarés par les stations. Une absence de rupture déclarée ne garantit pas le stock."},
    "onde_isere": {"label": "Écoulement des petits cours d’eau · ONDE", "interval": 21600,
        "source": "https://www.data.gouv.fr/dataservices/hubeau-ecoulement-des-cours-deau",
        "note": "Observations visuelles de campagne OFB, principalement estivales ; ce ne sont pas des mesures en temps réel."},
    "catnat_isere": {"label": "Historique CatNat · Isère", "interval": 86400,
        "source": "https://www.georisques.gouv.fr/doc-api",
        "note": "Arrêtés historiques de reconnaissance de catastrophe naturelle, sans indication d’alerte actuelle. Recherche sur les communes actuelles de l’Isère."},
    "energy_aura": {"label": "Électricité régionale · RTE", "interval": 3600,
        "source": "https://www.rte-france.com/donnees-publications/eco2mix-donnees-temps-reel/donnees-regionales",
        "note": "Puissances régionales Auvergne-Rhône-Alpes, en MW. Données mesurées et estimées ; elles ne localisent pas les coupures électriques."},
    "recalls": {"label": "Rappels de produits · RappelConso", "interval": 3600,
        "source": "https://data.economie.gouv.fr/explore/dataset/rappelconso-v2-gtin-espaces/",
        "note": "Publications des 90 derniers jours. La zone de vente est déclarative ; une portée nationale ou régionale ne confirme pas la distribution dans chaque commune."},
}
ALLOWED_HOSTS = {"data.economie.gouv.fr", "odre.opendatasoft.com", "opendata.reseaux-energies.fr",
                 "hubeau.eaufrance.fr", "www.georisques.gouv.fr", "geo.api.gouv.fr"}
FUELS = {"gazole": "Gazole", "sp95": "SP95", "e85": "E85", "gplc": "GPLc", "e10": "E10", "sp98": "SP98"}
GENERATION = {"nucleaire": "Nucléaire", "hydraulique": "Hydraulique", "thermique": "Thermique",
              "eolien": "Éolien", "solaire": "Solaire", "bioenergies": "Bioénergies"}


class SourceError(ValueError):
    """Diagnostic code only; do not expose upstream bodies or exception URLs."""


def _now():
    return datetime.now(timezone.utc)


def _iso(value=None):
    return (value or _now()).astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _date(value):
    try:
        result = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
        return result.replace(tzinfo=timezone.utc) if result.tzinfo is None else result.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def _french_date(value):
    parsed = _date(value)
    if parsed:
        return parsed.date().isoformat()
    try:
        return datetime.strptime(str(value), "%d/%m/%Y").date().isoformat()
    except (ValueError, TypeError):
        return None


def _number(value):
    if value is None or isinstance(value, bool) or value == "":
        return None
    try:
        value = float(str(value).replace(",", "."))
        return value if math.isfinite(value) else None
    except (ValueError, TypeError, OverflowError):
        return None


def _text(value, limit=500):
    return str(value or "").strip()[:limit]


def _normal(value):
    return "".join(c for c in unicodedata.normalize("NFD", _text(value, 3000).lower()) if not unicodedata.combining(c))


def _cache_dir():
    from .config import settings
    path = Path(settings.static_data_dir) / "public_sources"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _read(name):
    try:
        path = _cache_dir() / (name + ".json")
        if path.stat().st_size > MAX_BYTES:
            return {}
        result = json.loads(path.read_text(encoding="utf-8"))
        return result if isinstance(result, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(name, value):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=_cache_dir(), prefix=".public-", delete=False) as output:
            temporary = Path(output.name)
            output.write(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        temporary.replace(_cache_dir() / (name + ".json"))
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


class _Redirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        old, new = urlsplit(request.full_url), urlsplit(new_url)
        if new.scheme != "https" or new.hostname != old.hostname or new.port not in (None, 443):
            raise SourceError("unsafe_redirect")
        return super().redirect_request(request, response, code, message, headers, new_url)


def _json(url, params=None):
    target = urlsplit(url)
    if target.scheme != "https" or target.hostname not in ALLOWED_HOSTS or target.port not in (None, 443) or target.username or target.password:
        raise SourceError("invalid_endpoint")
    if params:
        url += "?" + urlencode(params)
    try:
        deadline = monotonic() + 25
        with build_opener(_Redirects()).open(Request(url, headers={
            "Accept": "application/json", "User-Agent": "OpeProtec/1.0 (sources publiques)"}), timeout=10) as response:
            chunks, size = [], 0
            while True:
                chunk = response.read1(min(65536, MAX_BYTES + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_BYTES or monotonic() > deadline:
                    raise SourceError("response_limit")
        raw = b"".join(chunks)
        if raw.startswith(b"\x1f\x8b"):
            with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
                raw = compressed.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise SourceError("response_limit")
        return json.loads(raw)
    except HTTPError as error:
        raise SourceError("rate_limited" if error.code == 429 else "provider_unavailable") from None
    except SourceError:
        raise
    except Exception:
        raise SourceError("invalid_response") from None


def _ods(url, where, *, order_by=None, max_pages=30):
    rows, expected = [], None
    for page in range(max_pages):
        params = {"where": where, "limit": 100, "offset": page * 100}
        if order_by:
            params["order_by"] = order_by
        payload = _json(url, params)
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
            raise SourceError("invalid_response")
        count = _number(payload.get("total_count"))
        if count is None or count < 0:
            raise SourceError("invalid_response")
        expected = int(count)
        batch = payload["results"]
        if any(not isinstance(row, dict) for row in batch):
            raise SourceError("invalid_response")
        rows.extend(batch)
        if len(rows) >= expected:
            return rows, False, expected
        if not batch:
            raise SourceError("incomplete_response")
    return rows, True, expected


def _collected(key, loader, force_refresh):
    definition = DEFINITIONS[key]
    previous = _read(key)
    checked = _date(previous.get("checked_at"))
    if not force_refresh and checked and 0 <= (_now() - checked).total_seconds() < definition["interval"]:
        return deepcopy(previous)
    try:
        payload = loader()
        payload = {"status": "online", **payload, "checked_at": _iso(), "updated_at": _iso()}
    except Exception as error:
        payload = deepcopy(previous)
        payload.update(status="stale" if previous.get("updated_at") else "unavailable", checked_at=_iso(),
                       error="Quota du fournisseur atteint. Nouvelle tentative ultérieure." if isinstance(error, SourceError) and str(error) == "rate_limited"
                       else "Source temporairement indisponible. Les dernières données connues sont conservées lorsqu’elles existent.")
    payload.update(service=definition["label"], source=definition["source"], note=definition["note"],
                   refresh_interval_seconds=definition["interval"])
    try:
        _write(key, payload)
    except OSError:
        # Shared Redis/main snapshot can still deliver the successful collection.
        payload["cache_warning"] = "Cache local indisponible."
    return payload


def _fuel_hours(row):
    raw = row.get("horaires")
    try:
        raw = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        raw = {}
    days = raw.get("jour", []) if isinstance(raw, dict) else []
    if isinstance(days, dict):
        days = [days]
    result = []
    for day in days[:7]:
        if not isinstance(day, dict):
            continue
        slots = day.get("horaire") or []
        if isinstance(slots, dict):
            slots = [slots]
        result.append({"day": _text(day.get("@nom"), 15), "closed": str(day.get("@ferme")) == "1",
                       "slots": [{"from": _text(slot.get("@ouverture"), 8), "to": _text(slot.get("@fermeture"), 8)}
                                 for slot in slots[:3] if isinstance(slot, dict)]})
    return result


def _fuel_loader():
    rows, truncated, expected = _ods(ECONOMY + FUEL_DATASET + "/records", "code_departement='38'", order_by="id", max_pages=10)
    stations = {}
    for row in rows:
        if str(row.get("code_departement")) != "38":
            continue
        geom = row.get("geom") or {}
        lat, lon = _number(geom.get("lat")), _number(geom.get("lon"))
        if lat is None or lon is None:
            lat, lon = _number(row.get("latitude")), _number(row.get("longitude"))
            lat = lat / 100000 if lat is not None and abs(lat) > 90 else lat
            lon = lon / 100000 if lon is not None and abs(lon) > 180 else lon
        identifier = str(row.get("id") or "")
        if not identifier.isdigit():
            continue
        if lat is None or lon is None or not (44 <= lat <= 47 and 4 <= lon <= 8):
            lat = lon = None
        prices = []
        available = {_normal(value) for value in (row.get("carburants_disponibles") or [])}
        for key, label in FUELS.items():
            price = _number(row.get(key + "_prix"))
            price = price if price is not None and 0 < price < 15 else None
            shortage = _text(row.get(key + "_rupture_type"), 30).lower()
            if price is None and not shortage and _normal(label) not in available:
                continue
            observed = _date(row.get(key + "_maj"))
            prices.append({"fuel": label, "price_eur": price, "updated_at": _iso(observed) if observed else None,
                           "old_price": observed is None or (_now() - observed).total_seconds() > 7 * 86400,
                           "shortage": "temporary" if shortage == "temporaire" else "discontinued" if shortage == "definitive" else None,
                           "shortage_since": row.get(key + "_rupture_debut")})
        stations[identifier] = {"id": identifier, "commune": _text(row.get("ville"), 120), "address": _text(row.get("adresse"), 220),
            "postal_code": _text(row.get("cp"), 10), "lat": lat, "lon": lon, "fuels": prices,
            "automate_24h": True if row.get("horaires_automate_24_24") == "Oui" else False if row.get("horaires_automate_24_24") == "Non" else None,
            "hours": _fuel_hours(row), "services": [_text(item, 100) for item in (row.get("services_service") or [])[:20]]}
    if rows and not stations:
        raise SourceError("invalid_department")
    stations = sorted(stations.values(), key=lambda station: (_normal(station["commune"]), station["id"]))
    return {"status": "partial" if truncated else "online", "stations": stations, "stations_total": len(stations),
            "provider_total": expected, "truncated": truncated,
            "temporary_shortage_stations": sum(any(fuel["shortage"] == "temporary" for fuel in station["fuels"]) for station in stations)}


def fetch_fuel_isere(force_refresh=False):
    return _collected("fuel_isere", _fuel_loader, force_refresh)


def _onde_loader():
    rows, total = [], None
    for page in range(1, 11):
        payload = _json(ONDE_API, {"code_departement": "38", "date_observation_min": (_now() - timedelta(days=400)).date().isoformat(),
                                   "size": 1000, "sort": "desc", "page": page})
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), list) or _number(payload.get("count")) is None:
            raise SourceError("invalid_response")
        total = int(payload["count"])
        batch = payload["data"]
        rows.extend(batch)
        if len(rows) >= total:
            break
        if not batch:
            raise SourceError("incomplete_response")
    stations = {}
    for row in rows:
        if not isinstance(row, dict) or str(row.get("code_departement")) != "38":
            continue
        identifier, observed = _text(row.get("code_station"), 40), _date(row.get("date_observation"))
        if not identifier or not observed or observed.date() > _now().date():
            continue
        if identifier in stations and stations[identifier]["observed_at"] >= observed.date().isoformat():
            continue
        code = str(row.get("code_ecoulement") or "")
        labels = {"1": "Écoulement visible", "1a": "Écoulement visible acceptable", "1f": "Écoulement visible faible",
                  "2": "Écoulement non visible", "3": "Assec"}
        lat, lon = _number(row.get("latitude")), _number(row.get("longitude"))
        if lat is None or lon is None or not (44 <= lat <= 47 and 4 <= lon <= 8):
            lat = lon = None
        stations[identifier] = {"id": identifier, "name": _text(row.get("libelle_station"), 180), "commune": _text(row.get("libelle_commune"), 120),
            "code_insee": _text(row.get("code_commune"), 5), "river": _text(row.get("libelle_cours_eau"), 120), "lat": lat, "lon": lon,
            "observed_at": observed.date().isoformat(), "flow_code": code, "flow_label": labels.get(code, _text(row.get("libelle_ecoulement")) or "Non renseigné")}
    if rows and not stations:
        raise SourceError("invalid_department")
    stations = sorted(stations.values(), key=lambda station: (_normal(station["commune"]), station["id"]))
    return {"status": "partial" if len(rows) < (total or 0) else "online", "stations": stations, "stations_total": len(stations),
            "observed_at": max((row["observed_at"] for row in stations), default=None),
            "dry_stations": sum(row["flow_code"] == "3" for row in stations),
            "invisible_flow_stations": sum(row["flow_code"] == "2" for row in stations), "lookback_days": 400}


def fetch_onde_isere(force_refresh=False):
    return _collected("onde_isere", _onde_loader, force_refresh)


def _communes():
    cached = _read("communes")
    checked = _date(cached.get("checked_at"))
    if checked and (_now() - checked).total_seconds() < 86400 and cached.get("communes"):
        return cached["communes"]
    try:
        payload = _json(COMMUNES_API, {"fields": "code,nom", "format": "json"})
        if not isinstance(payload, list):
            raise SourceError("invalid_response")
        communes = [{"code": row["code"], "name": _text(row.get("nom"), 120)} for row in payload
                    if isinstance(row, dict) and re.fullmatch(r"38[0-9]{3}", str(row.get("code", "")))]
        if not communes:
            raise SourceError("invalid_response")
        _write("communes", {"checked_at": _iso(), "communes": communes})
        return communes
    except Exception:
        if cached.get("communes"):
            return cached["communes"]
        raise


def _catnat_batch(codes, deadline=None):
    rows, complete = [], False
    for page in range(1, 31):
        if deadline is not None and monotonic() >= deadline:
            raise SourceError("collection_timeout")
        payload = _json(CATNAT_API, {"code_insee": ",".join(codes), "page": page, "page_size": 1000})
        if (not isinstance(payload, dict) or not isinstance(payload.get("data"), list)
                or payload.get("response_code") not in (None, 200) or _number(payload.get("total_pages")) is None):
            raise SourceError("invalid_response")
        if any(not isinstance(row, dict) for row in payload["data"]):
            raise SourceError("invalid_response")
        if any(str(row.get("code_insee")) not in codes for row in payload["data"]):
            raise SourceError("invalid_department")
        rows.extend(row for row in payload["data"] if str(row.get("code_insee")) in codes)
        # Never follow the provider's 'next': it can point to a private HTTP host.
        if page >= int(payload["total_pages"]):
            complete = True
            break
    return rows, complete


def _catnat_loader():
    deadline = monotonic() + 120
    communes = _communes()
    codes = [row["code"] for row in communes]
    previous = _read("catnat_history")
    by_code = {code: [] for code in codes}
    for row in previous.get("events", []):
        if row.get("code_insee") in by_code:
            by_code[row["code_insee"]].append(row)
    successes = set()
    def fetch_batch(batch):
        try:
            rows, complete = _catnat_batch(batch, deadline)
            return batch, rows, complete
        except Exception:
            return batch, [], False
    batches = [codes[index:index + 10] for index in range(0, len(codes), 10)]
    with ThreadPoolExecutor(max_workers=3) as executor:
        for batch, rows, complete in executor.map(fetch_batch, batches):
            if not complete:
                continue
            successes.update(batch)
            for code in batch:
                by_code[code] = []
            for row in rows:
                code = str(row.get("code_insee"))
                event = {"id": _text(row.get("code_national_catnat"), 80), "code_insee": code,
                    "commune": _text(row.get("libelle_commune"), 120), "risk": _text(row.get("libelle_risque_jo"), 240),
                    "event_start": _french_date(row.get("date_debut_evt")), "event_end": _french_date(row.get("date_fin_evt")),
                    "order_date": _french_date(row.get("date_publication_arrete")), "published_at": _french_date(row.get("date_publication_jo"))}
                if not event["id"] or not event["risk"]:
                    continue
                by_code[code].append(event)
    if not successes:
        raise SourceError("provider_unavailable")
    unique = {}
    for rows in by_code.values():
        for row in rows:
            unique[(row["id"], row["code_insee"], row["risk"], row["event_start"])] = row
    events = sorted(unique.values(), key=lambda row: (row["published_at"] or "", row["event_start"] or "", row["code_insee"]), reverse=True)
    coverage = {"communes_total": len(codes), "communes_checked": len(successes), "complete": len(successes) == len(codes)}
    _write("catnat_history", {"events": events, "checked_at": _iso(), "coverage": coverage,
                               "commune_codes": codes, "failed_codes": sorted(set(codes) - successes)})
    summaries = [{**row, "events_total": len(by_code[row["code"]]), "checked": row["code"] in successes}
                 for row in communes]
    return {"status": "online" if coverage["complete"] else "partial", "events": events[:150], "events_total": len(events),
            "preview_limit": 150, "communes": sorted(summaries, key=lambda row: _normal(row["name"])), "coverage": coverage}


def fetch_catnat_isere(force_refresh=False):
    result = _collected("catnat_isere", _catnat_loader, force_refresh)
    # The public preview is capped at 150; annual totals need the full local history.
    history = _read("catnat_history")
    if history and result.get("status") in {"online", "partial", "stale"}:
        # Paris is UTC+1 at the year boundary (no timezone database required).
        year = (_now() + timedelta(hours=1)).year
        annual = [row for row in history.get("events", [])
                  if str(row.get("published_at") or "").startswith(f"{year}-")]
        result = {**result, "current_year": year, "current_year_events": annual,
                  "current_year_total": len(annual)}
    return result


def read_catnat_history(code_insee):
    if not re.fullmatch(r"38[0-9]{3}", str(code_insee)):
        raise ValueError("Code INSEE de l’Isère invalide.")
    payload = _read("catnat_history")
    if not payload:
        return {"status": "pending", "events": [], "code_insee": code_insee, "note": "Historique en cours de collecte en arrière-plan."}
    failed = code_insee in payload.get("failed_codes", [])
    known = code_insee in payload.get("commune_codes", [code_insee])
    checked = _date(payload.get("checked_at"))
    stale = checked is None or (_now() - checked).total_seconds() > 2 * DEFINITIONS["catnat_isere"]["interval"]
    return {"status": "partial" if failed or not known else "stale" if stale else "online", "code_insee": code_insee,
            "events": [row for row in payload.get("events", []) if row.get("code_insee") == code_insee],
            "checked_at": payload.get("checked_at"), "note": DEFINITIONS["catnat_isere"]["note"],
            "coverage_warning": "Commune absente du référentiel actuel collecté ; vérifier la source officielle." if not known else
                "La dernière collecte de cette commune a échoué ; données antérieures éventuelles." if failed else
                "Historique local ancien : consulter la source officielle pour les nouvelles publications." if stale else None}


def _energy_loader():
    rows, truncated, _ = _ods(ENERGY_API, "code_insee_region='84' AND consommation is not null", order_by="date_heure desc", max_pages=1)
    series = {}
    for row in rows:
        at, consumption = _date(row.get("date_heure")), _number(row.get("consommation"))
        if str(row.get("code_insee_region")) != "84" or at is None or at > _now() + timedelta(minutes=15) or consumption is None or consumption < 0:
            continue
        generation = {key: _number(row.get(key)) for key in GENERATION}
        production = sum(generation.values()) if all(value is not None and value >= 0 for value in generation.values()) else None
        series[_iso(at)] = {"at": _iso(at), "consumption_mw": consumption, "production_mw": production, "generation_mw": generation}
    series = sorted(series.values(), key=lambda row: row["at"])
    if not series:
        raise SourceError("no_measured_values")
    latest = series[-1]
    age = (_now() - _date(latest["at"])).total_seconds()
    return {"status": "stale" if age > 10800 else "online", "observed_at": latest["at"], "region": "Auvergne-Rhône-Alpes", "region_code": "84",
            "unit": "MW", "latest": latest, "series": series, "generation_labels": GENERATION,
            "info_state": "Dernière mesure régionale disponible, âgée de plus de trois heures." if age > 10800 else "Derniers créneaux mesurés disponibles ; les créneaux vides du fournisseur sont écartés."}


def fetch_energy_aura(force_refresh=False):
    return _collected("energy_aura", _energy_loader, force_refresh)


def _recall_scope(value):
    zone = _normal(value)
    if re.search(r"\bisere\b|\b38\b", zone):
        return "isere"
    if "auvergne-rhone-alpes" in zone or "auvergne rhone alpes" in zone:
        return "region"
    if re.search(r"france entiere|toute la france|france metropolitaine|\bmetropole\b|\beurope\b", zone) or zone == "france":
        return "national"
    # Free text is not a reliable exclusion filter. Unknown scopes stay visible
    # in a separate view, including cities or attached distribution lists.
    return "unspecified"


def _recalls_loader():
    since = (_now() - timedelta(days=90)).date().isoformat()
    rows, truncated, expected = _ods(ECONOMY + RECALL_DATASET + "/records", f"date_publication >= date'{since}'",
                                     order_by="date_publication desc", max_pages=30)
    items = {}
    for row in rows:
        published = _date(row.get("date_publication"))
        identifier = str(row.get("id") or "")
        if not published or published > _now() + timedelta(minutes=15) or not identifier.isdigit():
            continue
        number = _text(row.get("numero_fiche"), 80) or identifier
        version = _number(row.get("numero_version")) or 0
        if number in items and items[number]["version"] >= version:
            continue
        expiry = _french_date(row.get("date_de_fin_de_la_procedure_de_rappel"))
        identity = row.get("identification_produits") or []
        identity = " · ".join(_text(value, 150) for value in identity[:30]) if isinstance(identity, list) else _text(identity, 1200)
        items[number] = {"id": identifier, "reference": number, "version": version, "published_at": _iso(published),
            "name": _text(row.get("libelle"), 240), "brand": _text(row.get("marque_produit"), 160), "category": _text(row.get("categorie_produit"), 100),
            "models": _text(row.get("modeles_ou_references"), 700), "identification": identity,
            "scope": _recall_scope(row.get("zone_geographique_de_vente")), "sale_area": _text(row.get("zone_geographique_de_vente"), 700),
            "distributors": _text(row.get("distributeurs"), 700), "reason": _text(row.get("motif_rappel"), 700),
            "risk": _text(row.get("risques_encourus"), 700), "actions": _text(row.get("conduites_a_tenir_par_le_consommateur"), 700),
            "expires_at": expiry, "active": None if not expiry else expiry >= _now().date().isoformat(),
            "source_url": f"https://rappel.conso.gouv.fr/fiche-rappel/{identifier}/interne"}
    items = sorted(items.values(), key=lambda row: row["published_at"], reverse=True)
    _write("recall_details", {"checked_at": _iso(), "items": items})
    # Keep long lot lists and instructions out of every bootstrap/SSE message.
    summary_fields = {"id", "reference", "version", "published_at", "name", "brand", "category", "scope", "sale_area",
                      "distributors", "expires_at", "active", "source_url"}
    previews = [{key: (_text(value, 220) if key in {"sale_area", "distributors"} else value)
                 for key, value in row.items() if key in summary_fields} for row in items]
    return {"status": "partial" if truncated else "online", "items": previews, "items_total": len(items), "provider_total": expected,
            "truncated": truncated, "lookback_days": 90,
            "targeted_total": sum(row["scope"] != "unspecified" for row in items),
            "unspecified_total": sum(row["scope"] == "unspecified" for row in items)}


def fetch_recalls(force_refresh=False):
    return _collected("recalls", _recalls_loader, force_refresh)


def read_recall_detail(identifier):
    if not re.fullmatch(r"[0-9]{1,15}", str(identifier)):
        raise ValueError("Identifiant de rappel invalide.")
    payload = _read("recall_details")
    for row in payload.get("items", []):
        if row.get("id") == identifier:
            checked = _date(payload.get("checked_at"))
            stale = checked is None or (_now() - checked).total_seconds() > 2 * DEFINITIONS["recalls"]["interval"]
            return {"status": "stale" if stale else "online", "item": row, "checked_at": payload.get("checked_at")}
    return None


FETCHERS = {"fuel_isere": fetch_fuel_isere, "onde_isere": fetch_onde_isere, "catnat_isere": fetch_catnat_isere,
            "energy_aura": fetch_energy_aura, "recalls": fetch_recalls}
