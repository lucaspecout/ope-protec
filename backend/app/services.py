from datetime import datetime, timedelta
from copy import deepcopy
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


def fetch_vigicrues_isere(
    sample_size: int = 1200,
    station_limit: int | None = None,
    priority_names: list[str] | None = None,
) -> dict[str, Any]:
    rss_source = "https://www.vigicrues.gouv.fr/territoire/rss"
    isere_territory_codes = {"18", "17", "16", "15", "14"}
    priority_names = [name.lower() for name in (priority_names or [])]

    try:
        xml_payload = _http_get_text(rss_source)
        root = ET.fromstring(xml_payload)
        isere_stations: list[dict[str, Any]] = []

        for item in root.findall(".//item")[:sample_size]:
            title = (item.findtext("title") or "").strip()
            description_html = (item.findtext("description") or "").strip()
            description = re.sub(r"<[^>]+>", " ", description_html)
            description = re.sub(r"\s+", " ", description).strip()
            link = (item.findtext("link") or "https://www.vigicrues.gouv.fr").strip()
            published = (item.findtext("pubDate") or "").strip()

            territory_match = re.search(r"CdEntVigiCru=(\d+)", link)
            territory_code = territory_match.group(1) if territory_match else ""
            text_blob = f"{title} {description}".lower()
            if territory_code and territory_code not in isere_territory_codes and "isere" not in text_blob and "isère" not in text_blob and "grenoble" not in text_blob:
                continue

            if "isère" not in text_blob and "isere" not in text_blob and "grenoble" not in text_blob:
                continue

            level_match = re.search(r":\s*(vert|jaune|orange|rouge)\s*$", title, re.IGNORECASE)
            if not level_match:
                level_match = re.search(r"Couleur de vigilance crues du tronçon\s*:\s*(vert|jaune|orange|rouge)", description, re.IGNORECASE)
            level = (level_match.group(1).lower() if level_match else "inconnu").replace("verte", "vert")

            troncon_match = re.search(r"Nom du tronçon\s*:\s*([^\(]+)", description, re.IGNORECASE)
            station_name = troncon_match.group(1).strip() if troncon_match else (title.split(":", 1)[0].strip() if title else "Tronçon Vigicrues")

            code_match = re.search(r"\(([A-Z]{1,3}\d{1,4})\)", description)
            station_code = code_match.group(1) if code_match else (item.findtext("guid") or link)

            commune_code_match = re.search(r"\b(38\d{3})\b", description)
            commune_code = commune_code_match.group(1) if commune_code_match else ""
            center = _commune_center(commune_code) if commune_code else None
            lat, lon = center if center else (None, None)

            is_priority = "grenoble" in text_blob or any(name in text_blob for name in priority_names)
            isere_stations.append(
                {
                    "code": station_code,
                    "station": station_name,
                    "river": "",
                    "height_m": 0.0,
                    "delta_window_m": 0.0,
                    "level": level,
                    "is_priority": is_priority,
                    "observed_at": published,
                    "lat": lat,
                    "lon": lon,
                    "commune_code": commune_code,
                    "source_link": link,
                }
            )

        if not isere_stations:
            raise ValueError("Aucune alerte Isère trouvée dans le flux RSS Vigicrues")

        isere_stations.sort(key=lambda station: (not station["is_priority"], station["station"] or ""))
        if station_limit is not None:
            isere_stations = isere_stations[:station_limit]

        levels = [s["level"] for s in isere_stations]
        global_level = "rouge" if "rouge" in levels else "orange" if "orange" in levels else "jaune" if "jaune" in levels else "vert"
        return {
            "service": "Vigicrues",
            "department": "Isère (38)",
            "status": "online",
            "source": rss_source,
            "water_alert_level": global_level,
            "stations": isere_stations,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError) as exc:
        return {
            "service": "Vigicrues",
            "department": "Isère (38)",
            "status": "degraded",
            "source": rss_source,
            "water_alert_level": "inconnu",
            "stations": [],
            "error": str(exc),
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
            events.append(
                {
                    "title": title,
                    "description": description[:400],
                    "published_at": published,
                    "link": link,
                }
            )
        return {
            "service": "Itinisère",
            "status": "online",
            "source": source,
            "events": events,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    except (ET.ParseError, HTTPError, URLError, TimeoutError, ValueError) as exc:
        return {
            "service": "Itinisère",
            "status": "degraded",
            "source": source,
            "events": [],
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
    errors: list[str] = []

    for commune in communes:
        code = commune["code_insee"]
        try:
            seismic = _http_get_json(f"{source}/zonage_sismique?code_insee={quote_plus(code)}")
            flood = _http_get_json(f"{source}/gaspar/azi?code_insee={quote_plus(code)}")

            seismic_data = (seismic or {}).get("data") or []
            flood_data = (flood or {}).get("data") or []
            seismic_label = (seismic_data[0] if seismic_data else {}).get("zone_sismicite", "inconnue")
            zone_code = int((seismic_data[0] if seismic_data else {}).get("code_zone", 0) or 0)
            highest_seismic = max(highest_seismic, zone_code)
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

            monitored.append(
                {
                    "name": commune["name"],
                    "code_insee": code,
                    "seismic_zone": seismic_label,
                    "flood_documents": len(flood_data),
                    "flood_documents_details": flood_documents_details,
                }
            )
        except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            errors.append(f"{commune['name']}: {exc}")

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
