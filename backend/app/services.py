from datetime import datetime, timedelta
from copy import deepcopy
from html import unescape
import json
from pathlib import Path
import re
from threading import Lock
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote_plus, urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from sqlalchemy import delete
from sqlalchemy.orm import Session

from .config import settings
from .models import Municipality, OperationalLog, WeatherAlert


def cleanup_old_weather_alerts(db: Session) -> int:
    cutoff = datetime.utcnow() - timedelta(days=settings.weather_retention_days)
    result = db.execute(delete(WeatherAlert).where(WeatherAlert.created_at < cutoff))
    db.commit()
    return result.rowcount or 0


def generate_pdf_report(db: Session, report_name: str = "rapport_veille.pdf") -> str:
    Path(settings.report_dir).mkdir(parents=True, exist_ok=True)
    report_path = str(Path(settings.report_dir) / report_name)
    c = canvas.Canvas(report_path, pagesize=A4)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(40, 800, "Protection Civile de l'Isère")
    c.drawString(40, 780, "Rapport de veille et gestion de crise")
    c.setFont("Helvetica", 10)
    y = 750

    latest_alert = db.query(WeatherAlert).order_by(WeatherAlert.created_at.desc()).first()
    crisis_count = db.query(Municipality).filter(Municipality.crisis_mode.is_(True)).count()
    logs = db.query(OperationalLog).order_by(OperationalLog.created_at.desc()).limit(20).all()

    c.drawString(40, y, f"Date: {datetime.utcnow().isoformat()}")
    y -= 20
    c.drawString(40, y, f"Synthèse: vigilance={latest_alert.level if latest_alert else 'vert'} ; communes en crise={crisis_count}")
    y -= 20
    c.drawString(40, y, "Carte: incluse via l'interface web (capture opérationnelle)")
    y -= 20
    c.drawString(40, y, "Graphiques: tendances vigilance/crues visualisées dans le tableau de bord")

    y -= 30
    c.setFont("Helvetica-Bold", 12)
    c.drawString(40, y, "Chronologie main courante")
    y -= 20
    c.setFont("Helvetica", 10)
    for log in logs:
        c.drawString(45, y, f"- {log.created_at:%d/%m %H:%M} {log.event_type}: {log.description[:78]}")
        y -= 14
        if y < 80:
            c.showPage()
            y = 800

    c.drawString(40, 60, "Signature: ____________________")
    c.save()
    return report_path


def _http_get_json(url: str, timeout: int = 10) -> Any:
    request = Request(url, headers={"User-Agent": "ope-protec/1.0"})
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _http_get_text(url: str, timeout: int = 10) -> str:
    request = Request(url, headers={"User-Agent": "ope-protec/1.0"})
    with urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="ignore")




def _extract_meteo_hazards(*chunks: str) -> list[str]:
    blob = " ".join((chunk or "").lower() for chunk in chunks)
    hazard_map = {
        "inondation": ["inondation", "pluie-inondation", "pluie"],
        "vent violent": ["vent"],
        "neige-verglas": ["neige", "verglas"],
        "orages": ["orage"],
        "canicule": ["canicule", "chaleur"],
        "grand froid": ["froid", "grand froid"],
        "avalanches": ["avalanche"],
    }
    hazards = [label for label, keywords in hazard_map.items() if any(keyword in blob for keyword in keywords)]
    return hazards


def _rot13_letters(value: str) -> str:
    transformed: list[str] = []
    for char in value:
        if "a" <= char <= "z":
            transformed.append(chr((ord(char) - ord("a") + 13) % 26 + ord("a")))
        elif "A" <= char <= "Z":
            transformed.append(chr((ord(char) - ord("A") + 13) % 26 + ord("A")))
        else:
            transformed.append(char)
    return "".join(transformed)


def _extract_mf_token_from_page() -> str:
    request = Request("https://vigilance.meteofrance.fr/fr/isere", headers={"User-Agent": "ope-protec/1.0"})
    with urlopen(request, timeout=15) as response:
        cookie_headers = response.headers.get_all("Set-Cookie") or []
    joined = "; ".join(cookie_headers)
    match = re.search(r"mfsession=([^;]+)", joined)
    if not match:
        raise ValueError("Cookie mfsession introuvable")
    return _rot13_letters(match.group(1))


def _meteo_france_wsft_get(path: str, token: str, params: dict[str, Any], version: str = "v3") -> dict[str, Any]:
    query = urlencode(params)
    url = f"https://rwg.meteofrance.com/wsft/{version}/{path}?{query}"
    request = Request(url, headers={"User-Agent": "ope-protec/1.0", "Authorization": f"Bearer {token}"})
    with urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def _parse_mf_bulletin_items(bulletin_payload: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for block in bulletin_payload.get("text_bloc_item") or []:
        for bloc_item in block.get("bloc_items") or []:
            for text_item in bloc_item.get("text_items") or []:
                details: list[str] = []
                for term in text_item.get("term_items") or []:
                    for subdivision in term.get("subdivision_text") or []:
                        snippets = subdivision.get("text") or []
                        if snippets:
                            details.append(" ".join(str(part).strip() for part in snippets if str(part).strip()))

                cleaned_details = " ".join(chunk for chunk in details if chunk).strip()
                if not cleaned_details:
                    continue

                items.append(
                    {
                        "section": bloc_item.get("type_name") or "Information",
                        "phenomenon": text_item.get("hazard_name") or "Tous aléas",
                        "detail": cleaned_details,
                    }
                )
    return items


def _build_mf_alerts(
    warning_payload: dict[str, Any],
    phenomenon_names: dict[str, str],
    color_names: dict[int, str],
    bulletin_items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    bulletin_by_phenomenon: dict[str, list[str]] = {}
    for entry in bulletin_items:
        key = str(entry.get("phenomenon") or "").lower()
        if key:
            bulletin_by_phenomenon.setdefault(key, []).append(entry.get("detail", ""))

    alerts: list[dict[str, Any]] = []
    for item in warning_payload.get("phenomenons_max_colors") or []:
        phenomenon_id = str(item.get("phenomenon_id") or "")
        color_id = int(item.get("phenomenon_max_color_id") or 1)
        phenomenon_name = phenomenon_names.get(phenomenon_id, f"Phénomène {phenomenon_id}")
        color_name = color_names.get(color_id, "inconnu").lower()
        details = bulletin_by_phenomenon.get(phenomenon_name.lower(), [])
        alerts.append(
            {
                "phenomenon": phenomenon_name,
                "level": color_name,
                "is_warning": color_id >= 2,
                "details": details[:2],
            }
        )

    alerts.sort(key=lambda alert: {"rouge": 4, "orange": 3, "jaune": 2, "vert": 1}.get(alert["level"], 0), reverse=True)
    return alerts


_MF_CACHE_TTL_SECONDS = 180
_meteo_cache_lock = Lock()
_meteo_cache: dict[str, Any] = {"payload": None, "expires_at": datetime.min}


def _highest_vigilance_level(alerts: list[dict[str, Any]]) -> str:
    priority = {"vert": 1, "jaune": 2, "orange": 3, "rouge": 4}
    highest = "vert"
    highest_score = priority[highest]
    for alert in alerts:
        level = str(alert.get("level") or "vert").lower()
        score = priority.get(level, 0)
        if score > highest_score:
            highest = level
            highest_score = score
    return highest


def _fetch_meteo_france_isere_live() -> dict[str, Any]:
    source_url = "https://vigilance.meteofrance.fr/fr/isere"
    html = _http_get_text(source_url)
    title_match = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    desc_match = re.search(r'<meta name="description" content="(.*?)"', html, re.IGNORECASE)
    color_match = re.search(r"vigilance (verte|jaune|orange|rouge)", html, re.IGNORECASE)
    level = color_match.group(1).lower() if color_match else "inconnu"
    level = "vert" if level == "verte" else level
    bulletin_title = title_match.group(1).strip() if title_match else "Vigilance Météo Isère"
    info_state = desc_match.group(1).replace("&#039;", "'") if desc_match else "Informations disponibles"
    hazards = _extract_meteo_hazards(bulletin_title, info_state)

    token = _extract_mf_token_from_page()
    dictionary = _meteo_france_wsft_get("warning/dictionary", token, {"domain": "FRA", "warning_type": "vigilance"})
    warning_today = _meteo_france_wsft_get(
        "warning/currentphenomenons",
        token,
        {"domain": "38", "warning_type": "vigilance", "formatDate": "timestamp", "echeance": "J0", "depth": 1},
    )
    warning_tomorrow = _meteo_france_wsft_get(
        "warning/currentphenomenons",
        token,
        {"domain": "38", "warning_type": "vigilance", "formatDate": "timestamp", "echeance": "J1", "depth": 1},
    )
    bulletin_today = _meteo_france_wsft_get(
        "report",
        token,
        {"domain": "38", "report_type": "vigilanceV6", "report_subtype": "Bulletin de suivi", "echeance": "J0"},
        version="v2",
    )
    bulletin_tomorrow = _meteo_france_wsft_get(
        "report",
        token,
        {"domain": "38", "report_type": "vigilanceV6", "report_subtype": "Bulletin de suivi", "echeance": "J1"},
        version="v2",
    )

    phenomenon_names = {str(item.get("id")): item.get("name", "") for item in dictionary.get("phenomenons") or []}
    color_names = {int(item.get("id")): item.get("name", "inconnu") for item in dictionary.get("colors") or []}
    today_bulletin_items = _parse_mf_bulletin_items(bulletin_today)
    tomorrow_bulletin_items = _parse_mf_bulletin_items(bulletin_tomorrow)
    current_alerts = _build_mf_alerts(warning_today, phenomenon_names, color_names, today_bulletin_items)
    tomorrow_alerts = _build_mf_alerts(warning_tomorrow, phenomenon_names, color_names, tomorrow_bulletin_items)
    monitored_hazards = [alert["phenomenon"].lower() for alert in current_alerts + tomorrow_alerts]
    hazards = sorted(set(hazards + [hazard for hazard in monitored_hazards if hazard]))
    if current_alerts:
        level = _highest_vigilance_level(current_alerts)
    elif tomorrow_alerts:
        level = _highest_vigilance_level(tomorrow_alerts)

    return {
        "service": "Météo-France Vigilance",
        "department": "Isère (38)",
        "status": "online",
        "source": source_url,
        "level": level,
        "bulletin_title": bulletin_title,
        "info_state": info_state,
        "hazards": hazards,
        "current_alerts": current_alerts,
        "tomorrow_alerts": tomorrow_alerts,
        "bulletin_today": today_bulletin_items[:4],
        "bulletin_tomorrow": tomorrow_bulletin_items[:4],
        "updated_at": datetime.utcnow().isoformat() + "Z",
    }


def fetch_meteo_france_isere(force_refresh: bool = False) -> dict[str, Any]:
    now = datetime.utcnow()
    with _meteo_cache_lock:
        cached_payload = _meteo_cache.get("payload")
        expires_at = _meteo_cache.get("expires_at") or datetime.min
        if not force_refresh and cached_payload and now < expires_at:
            return deepcopy(cached_payload)

    try:
        payload = _fetch_meteo_france_isere_live()
        with _meteo_cache_lock:
            _meteo_cache["payload"] = deepcopy(payload)
            _meteo_cache["expires_at"] = datetime.utcnow() + timedelta(seconds=_MF_CACHE_TTL_SECONDS)
        return payload
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        with _meteo_cache_lock:
            cached_payload = _meteo_cache.get("payload")
            if cached_payload:
                degraded_payload = deepcopy(cached_payload)
                degraded_payload["status"] = "stale"
                degraded_payload["info_state"] = f"Données mises en cache (dernière tentative indisponible: {exc})"
                return degraded_payload
        return {
            "service": "Météo-France Vigilance",
            "department": "Isère (38)",
            "status": "degraded",
            "source": "https://vigilance.meteofrance.fr/fr/isere",
            "level": "inconnu",
            "info_state": f"indisponible ({exc})",
            "hazards": [],
            "current_alerts": [],
            "tomorrow_alerts": [],
            "bulletin_today": [],
            "bulletin_tomorrow": [],
        }


def fetch_isere_boundary_geojson() -> dict[str, Any]:
    source_url = "https://france-geojson.gregoiredavid.fr/repo/departements/38-isere/departement-38-isere.geojson"
    try:
        data = _http_get_json(source_url)
        geometry = data.get("geometry", {})
        if geometry.get("type") not in {"Polygon", "MultiPolygon"}:
            raise ValueError("Format géométrique inattendu")

        return {
            "status": "online",
            "source": source_url,
            "geometry": geometry,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        return {
            "status": "degraded",
            "source": source_url,
            "error": str(exc),
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [5.09, 45.07], [5.63, 45.61], [6.45, 45.28], [6.35, 44.84], [5.73, 44.63], [5.15, 44.82], [5.09, 45.07],
                ]],
            },
        }


def _vigicrues_level_from_delta(delta_m: float) -> str:
    if delta_m >= 1:
        return "rouge"
    if delta_m >= 0.5:
        return "orange"
    if delta_m >= 0.2:
        return "jaune"
    return "vert"


def _vigicrues_extract_observation(station_code: str) -> tuple[float, float, str]:
    try:
        payload = _http_get_json(
            f"https://www.vigicrues.gouv.fr/services/observations.json/index.php?CdStationHydro={quote_plus(station_code)}&FormatDate=iso"
        )
    except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
        return 0.0, 0.0, ""

    observations = ((payload.get("Serie") or {}).get("ObssHydro") or [])
    valid = [item for item in observations if item.get("ResObsHydro") not in (None, "")]
    if not valid:
        return 0.0, 0.0, ""

    latest = valid[-1]
    previous = valid[-2] if len(valid) >= 2 else latest
    latest_height = float(latest.get("ResObsHydro") or 0.0)
    previous_height = float(previous.get("ResObsHydro") or latest_height)
    delta = latest_height - previous_height
    observed_at = str(latest.get("DtObsHydro") or "")
    return latest_height, delta, observed_at


def _normalize_vigicrues_coordinates(coord_x: Any, coord_y: Any, commune_code: str) -> tuple[float | None, float | None]:
    try:
        lon = float(coord_x) if coord_x not in (None, "") else None
        lat = float(coord_y) if coord_y not in (None, "") else None
    except (TypeError, ValueError):
        lon = None
        lat = None

    if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180:
        return lat, lon

    fallback_center = _commune_center(commune_code) if commune_code else None
    if fallback_center:
        return fallback_center
    return None, None


def _commune_center(code_insee: str) -> tuple[float, float] | None:
    try:
        payload = _http_get_json(f"https://geo.api.gouv.fr/communes/{quote_plus(code_insee)}?fields=centre")
        coordinates = payload.get("centre", {}).get("coordinates")
        if not coordinates or len(coordinates) != 2:
            return None
        lon, lat = coordinates
        return float(lat), float(lon)
    except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
        return None


def _vigicrues_station_control(details: dict[str, Any]) -> str:
    direct_candidates = [
        "EtatStationHydro",
        "EtatControleStationHydro",
        "EtatStation",
        "EtatCapteur",
        "LibelleEtatStationHydro",
    ]
    nested_candidates = [
        ("VigilanceCrues", "EtatStationHydro"),
        ("VigilanceCrues", "EtatControleStationHydro"),
        ("VigilanceCrues", "LibelleEtatStationHydro"),
    ]

    for key in direct_candidates:
        value = details.get(key)
        if value not in (None, ""):
            return str(value)

    for parent_key, child_key in nested_candidates:
        parent_value = details.get(parent_key)
        if not isinstance(parent_value, dict):
            continue
        value = parent_value.get(child_key)
        if value not in (None, ""):
            return str(value)

    for key, value in details.items():
        if "controle" not in str(key).lower() and "control" not in str(key).lower():
            continue
        if isinstance(value, (str, int, float)) and value not in (None, ""):
            return str(value)

    return "inconnu"


def fetch_vigicrues_isere(
    sample_size: int = 1200,
    station_limit: int | None = None,
    priority_names: list[str] | None = None,
) -> dict[str, Any]:
    source = "https://www.vigicrues.gouv.fr"
    sandre_reference = "https://www.sandre.eaufrance.fr/definition/VIC/1.1/EntVigiCru"
    # 19 = Alpes du Nord (inclut l'Isère). On le priorise pour augmenter
    # fortement le nombre de stations iséroises disponibles côté cartographie.
    preferred_territory_codes = (19, 18, 17, 16, 15, 14)
    priority_names = [name.lower() for name in (priority_names or [])]

    try:
        catalog = _http_get_json(f"{source}/services/station.json")
        all_stations = (catalog.get("Stations") or []) if isinstance(catalog, dict) else []
        stations_by_territory: dict[int, list[str]] = {code: [] for code in preferred_territory_codes}
        for item in all_stations:
            territory_code = int(item.get("PereBoitEntVigiCru") or 0)
            if territory_code not in stations_by_territory:
                continue
            station_code = str(item.get("CdStationHydro") or "").strip()
            if station_code:
                stations_by_territory[territory_code].append(station_code)

        candidate_codes = [
            code
            for territory_code in preferred_territory_codes
            for code in stations_by_territory.get(territory_code, [])
        ]
        candidate_codes = [code for code in candidate_codes if code]
        max_lookups = max(80, station_limit * 15) if station_limit else 140
        if sample_size > 0:
            max_lookups = min(max_lookups, sample_size)
        candidate_codes = candidate_codes[:max_lookups]
        if not candidate_codes:
            raise ValueError("Aucune station candidate détectée pour l'Isère")

        isere_stations: list[dict[str, Any]] = []
        target_isere_count = max(station_limit or 0, 12)
        for station_code in candidate_codes:
            try:
                details = _http_get_json(f"{source}/services/station.json?CdStationHydro={quote_plus(station_code)}")
            except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
                continue

            commune_code = str(details.get("CdCommune") or "")
            if not commune_code.startswith("38"):
                continue

            coords = details.get("CoordStationHydro") or {}
            lat, lon = _normalize_vigicrues_coordinates(coords.get("CoordYStationHydro"), coords.get("CoordXStationHydro"), commune_code)
            station_name = details.get("LbStationHydro") or "Station Vigicrues"
            river_name = details.get("LbCoursEau") or ""
            text_blob = f"{station_name} {river_name}".lower()
            height_m, delta_window_m, observed_at = _vigicrues_extract_observation(station_code)
            level = _vigicrues_level_from_delta(abs(delta_window_m))

            isere_stations.append(
                {
                    "code": station_code,
                    "station": station_name,
                    "river": river_name,
                    "height_m": round(height_m, 2),
                    "delta_window_m": round(delta_window_m, 3),
                    "level": level,
                    "control_status": _vigicrues_station_control(details),
                    "is_priority": ("grenoble" in text_blob or any(name in text_blob for name in priority_names)),
                    "observed_at": observed_at,
                    "lat": lat,
                    "lon": lon,
                    "commune_code": commune_code,
                    "troncon": "",
                    "troncon_code": "",
                    "source_link": f"{source}/station/{station_code}",
                }
            )
            if len(isere_stations) >= target_isere_count:
                break

        if not isere_stations:
            raise ValueError("Aucune station du département de l'Isère trouvée")

        troncons_index: dict[str, dict[str, Any]] = {}
        for station in isere_stations:
            key = station.get("river") or "Cours d'eau non précisé"
            group = troncons_index.setdefault(
                key,
                {
                    "code": re.sub(r"[^A-Z0-9]", "", key.upper())[:12] or "ISERE",
                    "name": key,
                    "level": "vert",
                    "territory": "18",
                    "rss": None,
                    "stations": [],
                },
            )
            group["stations"].append({"code": station["code"], "station": station["station"], "river": station["river"]})
            group["level"] = _highest_vigilance_level([{"level": group["level"]}, {"level": station["level"]}])

        troncons = list(troncons_index.values())

        isere_stations.sort(key=lambda station: (not station["is_priority"], station["station"] or ""))
        troncons.sort(key=lambda troncon: troncon.get("name") or "")

        if station_limit is not None:
            isere_stations = isere_stations[:station_limit]

        levels = [s["level"] for s in isere_stations]
        global_level = "rouge" if "rouge" in levels else "orange" if "orange" in levels else "jaune" if "jaune" in levels else "vert"
        return {
            "service": "Vigicrues",
            "department": "Isère (38)",
            "status": "online",
            "source": source,
            "sandre_reference": sandre_reference,
            "water_alert_level": global_level,
            "stations": isere_stations,
            "troncons": troncons,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError) as exc:
        return {
            "service": "Vigicrues",
            "department": "Isère (38)",
            "status": "degraded",
            "source": source,
            "sandre_reference": sandre_reference,
            "water_alert_level": "inconnu",
            "stations": [],
            "troncons": [],
            "error": str(exc),
        }




def _itinisere_category(title: str, description: str) -> str:
    text = f"{title} {description}".lower()
    if any(word in text for word in ("fermeture", "coup", "interdit", "impossible")):
        return "fermeture"
    if any(word in text for word in ("travaux", "chantier", "alternat")):
        return "travaux"
    if any(word in text for word in ("accident", "collision", "panne", "obstacle")):
        return "incident"
    if any(word in text for word in ("neige", "verglas", "intemp", "pluie", "crue")):
        return "météo"
    if any(word in text for word in ("manifest", "évènement", "course", "marché")):
        return "évènement"
    return "trafic"


def _itinisere_extract_roads(text: str) -> list[str]:
    roads = {road.upper() for road in re.findall(r"\b([ADNMCR]\d{1,4})\b", text or "")}
    return sorted(roads)


def _itinisere_insights(events: list[dict[str, Any]]) -> dict[str, Any]:
    category_counts: dict[str, int] = {}
    road_counts: dict[str, int] = {}

    for event in events:
        category = str(event.get("category") or "trafic")
        category_counts[category] = category_counts.get(category, 0) + 1
        for road in event.get("roads") or []:
            road_counts[road] = road_counts.get(road, 0) + 1

    dominant_category = max(category_counts.items(), key=lambda item: item[1])[0] if category_counts else "aucune"
    top_roads = sorted(road_counts.items(), key=lambda item: item[1], reverse=True)[:5]

    return {
        "dominant_category": dominant_category,
        "category_breakdown": category_counts,
        "top_roads": [{"road": road, "count": count} for road, count in top_roads],
    }

def fetch_itinisere_disruptions(limit: int = 20) -> dict[str, Any]:
    source = "https://www.itinisere.fr/fr/rss/Disruptions"
    try:
        xml_payload = _http_get_text(source)
        root = ET.fromstring(xml_payload)
        events: list[dict[str, Any]] = []
        for item in root.findall(".//item")[:limit]:
            title = (item.findtext("title") or "Perturbation").strip()
            description = re.sub(r"\s+", " ", (item.findtext("description") or "").strip())
            published = (item.findtext("pubDate") or "").strip()
            link = (item.findtext("link") or "https://www.itinisere.fr").strip()
            roads = _itinisere_extract_roads(f"{title} {description}")
            category = _itinisere_category(title, description)
            events.append(
                {
                    "title": title,
                    "description": description[:400],
                    "published_at": published,
                    "link": link,
                    "roads": roads,
                    "category": category,
                }
            )
        insights = _itinisere_insights(events)
        return {
            "service": "Itinisère",
            "status": "online",
            "source": source,
            "events": events,
            "insights": insights,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError) as exc:
        return {
            "service": "Itinisère",
            "status": "degraded",
            "source": source,
            "events": [],
            "insights": {"dominant_category": "aucune", "category_breakdown": {}, "top_roads": []},
            "error": str(exc),
        }


def _bison_color_label(code: str) -> str:
    mapping = {
        "V": "vert",
        "J": "jaune",
        "O": "orange",
        "R": "rouge",
        "N": "noir",
    }
    return mapping.get((code or "").strip().upper(), "inconnu")


def _parse_bison_segment(segment: str) -> dict[str, str]:
    departure_code, _, return_code = (segment or "V,V").partition(",")
    return {
        "departure": _bison_color_label(departure_code),
        "return": _bison_color_label(return_code),
    }


def fetch_bison_fute_traffic() -> dict[str, Any]:
    source = "https://www.bison-fute.gouv.fr/previsions/previsions.json"
    try:
        payload = _http_get_json(source)
        days = payload.get("days") or []
        national = payload.get("national") or []
        depts = payload.get("deptsLine") or []
        values = payload.get("values") or []

        if not days or not national:
            raise ValueError("Prévisions Bison Futé vides")

        today = datetime.utcnow().strftime("%d/%m/%Y")
        day_index = days.index(today) if today in days else 0
        tomorrow_index = min(day_index + 1, len(days) - 1)

        isere_index = depts.index("38") if "38" in depts else None

        def pick_entry(index: int) -> dict[str, Any]:
            national_segment = _parse_bison_segment(national[index] if index < len(national) else "V,V")
            isere_segment = {"departure": "inconnu", "return": "inconnu"}
            if isere_index is not None and index < len(values) and isere_index < len(values[index]):
                isere_segment = _parse_bison_segment(values[index][isere_index])
            return {
                "date": days[index],
                "national": national_segment,
                "isere": isere_segment,
            }

        return {
            "service": "Bison Futé",
            "status": "online",
            "source": source,
            "today": pick_entry(day_index),
            "tomorrow": pick_entry(tomorrow_index),
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
        return {
            "service": "Bison Futé",
            "status": "degraded",
            "source": source,
            "today": {
                "date": "-",
                "national": {"departure": "inconnu", "return": "inconnu"},
                "isere": {"departure": "inconnu", "return": "inconnu"},
            },
            "tomorrow": {
                "date": "-",
                "national": {"departure": "inconnu", "return": "inconnu"},
                "isere": {"departure": "inconnu", "return": "inconnu"},
            },
            "error": str(exc),
        }


def fetch_georisques_isere_summary() -> dict[str, Any]:
    source = "https://www.georisques.gouv.fr/api/v1"
    communes = [
        {"name": "Grenoble", "code_insee": "38185"},
        {"name": "Bourgoin-Jallieu", "code_insee": "38053"},
        {"name": "Vienne", "code_insee": "38544"},
        {"name": "Voiron", "code_insee": "38563"},
    ]
    monitored: list[dict[str, Any]] = []
    highest_seismic = 0
    flood_documents_total = 0
    ppr_total = 0
    ground_movement_total = 0
    cavity_total = 0
    communes_with_radon_moderate_or_high = 0
    movement_types: dict[str, int] = {}
    recent_movements: list[dict[str, Any]] = []
    errors: list[str] = []

    radon_labels = {
        "1": "Faible",
        "2": "Moyen",
        "3": "Élevé",
    }

    for commune in communes:
        code = commune["code_insee"]
        commune_errors: list[str] = []
        try:
            seismic = _http_get_json(f"{source}/zonage_sismique?code_insee={quote_plus(code)}")
            seismic_data = (seismic or {}).get("data") or []
            seismic_label = (seismic_data[0] if seismic_data else {}).get("zone_sismicite", "inconnue")
            zone_code = int((seismic_data[0] if seismic_data else {}).get("code_zone", 0) or 0)
            highest_seismic = max(highest_seismic, zone_code)

            flood_data = []
            try:
                flood = _http_get_json(f"{source}/gaspar/azi?code_insee={quote_plus(code)}")
                flood_data = (flood or {}).get("data") or []
            except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
                commune_errors.append(f"AZI: {exc}")
            flood_documents_total += len(flood_data)
            flood_documents_details = [
                {
                    "code": item.get("code_national_azi"),
                    "title": item.get("libelle_azi"),
                    "river_basin": item.get("libelle_bassin_risques"),
                    "published_at": item.get("date_diffusion") or item.get("date_publication_web"),
                }
                for item in flood_data
            ]

            ppr_data = []
            ppr_by_risk: dict[str, int] = {}
            try:
                ppr = _http_get_json(f"{source}/ppr?code_insee={quote_plus(code)}")
                ppr_data = (ppr or {}).get("data") or []
                for item in ppr_data:
                    risk_name = str(item.get("risque") or "Non précisé").strip()
                    ppr_by_risk[risk_name] = ppr_by_risk.get(risk_name, 0) + 1
                ppr_total += len(ppr_data)
            except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
                commune_errors.append(f"PPR: {exc}")

            ground_movement_data = []
            try:
                movements = _http_get_json(f"{source}/mvt?code_insee={quote_plus(code)}")
                ground_movement_data = (movements or {}).get("data") or []
                ground_movement_total += len(ground_movement_data)
                for item in ground_movement_data:
                    movement_type = str(item.get("type") or "Type non renseigné").strip()
                    movement_types[movement_type] = movement_types.get(movement_type, 0) + 1
                    recent_movements.append(
                        {
                            "commune": commune["name"],
                            "type": movement_type,
                            "date": item.get("date_debut") or item.get("date_maj"),
                            "location": item.get("lieu"),
                            "identifier": item.get("identifiant"),
                            "reliability": item.get("fiabilite"),
                        }
                    )
            except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
                commune_errors.append(f"MVT: {exc}")

            cavity_data = []
            try:
                cavites = _http_get_json(f"{source}/cavites?code_insee={quote_plus(code)}")
                cavity_data = (cavites or {}).get("data") or []
                cavity_total += len(cavity_data)
            except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
                commune_errors.append(f"Cavités: {exc}")

            radon_class_value = None
            radon_label = "inconnu"
            try:
                radon = _http_get_json(f"{source}/radon?code_insee={quote_plus(code)}")
                radon_data = (radon or {}).get("data") or []
                radon_class_value = str((radon_data[0] if radon_data else {}).get("classe_potentiel") or "")
                radon_label = radon_labels.get(radon_class_value, "inconnu")
                if radon_class_value in {"2", "3"}:
                    communes_with_radon_moderate_or_high += 1
            except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
                commune_errors.append(f"Radon: {exc}")

            monitored.append(
                {
                    "name": commune["name"],
                    "code_insee": code,
                    "seismic_zone": seismic_label,
                    "flood_documents": len(flood_data),
                    "flood_documents_details": flood_documents_details,
                    "ppr_total": len(ppr_data),
                    "ppr_by_risk": ppr_by_risk,
                    "ground_movements_total": len(ground_movement_data),
                    "cavities_total": len(cavity_data),
                    "radon_class": radon_class_value,
                    "radon_label": radon_label,
                    "errors": commune_errors,
                }
            )
        except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            errors.append(f"{commune['name']}: {exc}")
            continue

        if commune_errors:
            errors.append(f"{commune['name']}: {' | '.join(commune_errors)}")

    status = "online"
    if errors and monitored:
        status = "partial"
    elif errors:
        status = "degraded"

    return {
        "service": "Géorisques",
        "status": status,
        "source": source,
        "department": "Isère (38)",
        "highest_seismic_zone_code": highest_seismic,
        "highest_seismic_zone_label": f"Zone {highest_seismic}" if highest_seismic else "inconnue",
        "flood_documents_total": flood_documents_total,
        "ppr_total": ppr_total,
        "ground_movements_total": ground_movement_total,
        "cavities_total": cavity_total,
        "communes_with_radon_moderate_or_high": communes_with_radon_moderate_or_high,
        "movement_types": movement_types,
        "recent_ground_movements": sorted(
            recent_movements,
            key=lambda item: item.get("date") or "",
            reverse=True,
        )[:12],
        "monitored_communes": monitored,
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "errors": errors,
        "error": " ; ".join(errors) if errors else None,
    }


def vigicrues_geojson_from_stations(stations: list[dict[str, Any]]) -> dict[str, Any]:
    features = []
    for station in stations:
        if station.get("lat") is None or station.get("lon") is None:
            continue
        features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [station["lon"], station["lat"]],
                },
                "properties": {
                    "code": station.get("code"),
                    "station": station.get("station"),
                    "river": station.get("river"),
                    "level": station.get("level"),
                    "height_m": station.get("height_m"),
                    "control_status": station.get("control_status", "inconnu"),
                    "is_priority": station.get("is_priority", False),
                    "observed_at": station.get("observed_at"),
                },
            }
        )

    return {
        "type": "FeatureCollection",
        "features": features,
        "source": "https://www.vigicrues.gouv.fr",
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }
