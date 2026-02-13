from datetime import datetime, timedelta
import json
from pathlib import Path
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from sqlalchemy import delete
from sqlalchemy.orm import Session

from .config import settings
from .models import OperationalLog, WeatherAlert


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
    c.drawString(40, 780, "Veille Opérationnelle – Isère")
    c.setFont("Helvetica", 10)
    y = 750
    c.drawString(40, y, f"Date: {datetime.utcnow().isoformat()}")
    y -= 30
    c.setFont("Helvetica-Bold", 12)
    c.drawString(40, y, "Chronologie main courante")
    y -= 20
    c.setFont("Helvetica", 10)
    logs = db.query(OperationalLog).order_by(OperationalLog.created_at.desc()).limit(15).all()
    for log in logs:
        c.drawString(45, y, f"- {log.created_at:%d/%m %H:%M} {log.event_type}: {log.description[:80]}")
        y -= 14
        if y < 80:
            c.showPage()
            y = 800
    c.drawString(40, 60, "Signature: ____________________")
    c.save()
    return report_path


def _http_get_json(url: str, timeout: int = 8) -> Any:
    request = Request(url, headers={"User-Agent": "ope-protec/1.0"})
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _http_get_text(url: str, timeout: int = 8) -> str:
    request = Request(url, headers={"User-Agent": "ope-protec/1.0"})
    with urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="ignore")


def fetch_meteo_france_isere() -> dict[str, Any]:
    source_url = "https://vigilance.meteofrance.fr/fr/isere"
    try:
        html = _http_get_text(source_url)
        title_match = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
        desc_match = re.search(r'<meta name="description" content="(.*?)"', html, re.IGNORECASE)
        return {
            "service": "Météo-France Vigilance",
            "department": "Isère (38)",
            "status": "online",
            "source": source_url,
            "bulletin_title": title_match.group(1).strip() if title_match else "Vigilance Météo Isère",
            "info_state": desc_match.group(1).replace("&#039;", "'") if desc_match else "Informations disponibles",
        }
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        return {
            "service": "Météo-France Vigilance",
            "department": "Isère (38)",
            "status": "degraded",
            "source": source_url,
            "info_state": f"indisponible ({exc})",
        }


def _vigicrues_level_from_delta(delta_m: float) -> str:
    if delta_m >= 1:
        return "rouge"
    if delta_m >= 0.5:
        return "orange"
    if delta_m >= 0.2:
        return "jaune"
    return "vert"


def fetch_vigicrues_isere(sample_size: int = 120, station_limit: int = 5) -> dict[str, Any]:
    base_url = "https://www.vigicrues.gouv.fr/services"
    try:
        observations = _http_get_json(f"{base_url}/observations.json?GrdSerie=H&FormatSortie=simple")
        station_codes = [code for _, code in observations.get("Observations", {}).get("ListeStation", [])][:sample_size]
        isere_stations: list[dict[str, Any]] = []

        for code in station_codes:
            try:
                station = _http_get_json(f"{base_url}/station.json?CdStationHydro={code}")
            except (HTTPError, URLError, TimeoutError, ValueError):
                continue

            commune_code = str(station.get("CdCommune", ""))
            if not commune_code.startswith("38"):
                continue

            series = _http_get_json(f"{base_url}/observations.json?CdStationHydro={code}&GrdSerie=H&FormatSortie=simple")
            values = series.get("Serie", {}).get("ObssHydro", [])
            if not values:
                continue

            latest_ts, latest_h = values[-1]
            old_h = values[0][1] if len(values) > 1 else latest_h
            delta = round(float(latest_h) - float(old_h), 2)
            isere_stations.append(
                {
                    "code": code,
                    "station": station.get("LbStationHydro"),
                    "river": station.get("LbCoursEau"),
                    "height_m": round(float(latest_h), 2),
                    "delta_window_m": delta,
                    "level": _vigicrues_level_from_delta(abs(delta)),
                    "observed_at": datetime.utcfromtimestamp(int(latest_ts) / 1000).isoformat() + "Z",
                }
            )
            if len(isere_stations) >= station_limit:
                break

        if not isere_stations:
            raise ValueError("Aucune station Isère détectée sur l'échantillon courant")

        levels = [s["level"] for s in isere_stations]
        global_level = "rouge" if "rouge" in levels else "orange" if "orange" in levels else "jaune" if "jaune" in levels else "vert"
        return {
            "service": "Vigicrues",
            "department": "Isère (38)",
            "status": "online",
            "source": "https://www.vigicrues.gouv.fr",
            "water_alert_level": global_level,
            "stations": isere_stations,
        }
    except (HTTPError, URLError, TimeoutError, ValueError) as exc:
        return {
            "service": "Vigicrues",
            "department": "Isère (38)",
            "status": "degraded",
            "source": "https://www.vigicrues.gouv.fr",
            "water_alert_level": "inconnu",
            "stations": [],
            "error": str(exc),
        }
