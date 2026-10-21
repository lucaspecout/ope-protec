"""Collect the current official Data ES inventory of potential indoor shelters.

An equipment record identifies a room, not a confirmed emergency accommodation
site. ERP classes and spectator seats never become a sleeping capacity.
"""
from __future__ import annotations

from datetime import datetime, timezone
from http.client import IncompleteRead
import json
import math
import socket
import time
import unicodedata
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen


HOSTING_SOURCE_URL = "https://equipements.sports.gouv.fr/explore/dataset/data-es/"
HOSTING_RECORDS_URL = "https://equipements.sports.gouv.fr/api/explore/v2.1/catalog/datasets/data-es/records"
HOSTING_SCHEMA_VERSION = 2
MAX_PAGE_BYTES = 1024 * 1024
MAX_PAGES = 50
MAX_ROWS = 5000
MAX_DURATION_SECONDS = 60
SOCKET_TIMEOUT_SECONDS = 10
_WHERE = ('dep_code="38" AND equip_nature="Intérieur" AND '
          '(search(equip_type_name,"salle") OR search(equip_type_name,"dojo") '
          'OR search(equip_type_name,"multisports"))')
_FIELDS = ("equip_numero,inst_numero,inst_nom,inst_adresse,inst_cp,new_name,new_code,dep_code,"
           "equip_nom,equip_type_name,equip_coordonnees,equip_x,equip_y,equip_nature,inst_hs_bool,"
           "equip_maj_date,equip_prop_nom,equip_prop_type,equip_gest_type,equip_ouv_public_bool,"
           "equip_erp_cat,equip_erp_type,equip_surf,equip_long,equip_larg,equip_haut,equip_sol,"
           "equip_energie,equip_sanit,equip_douche,equip_vest_sport,equip_trib_nb,equip_url,"
           "equip_pmr_acc,equip_pmr_aire,equip_pmr_chem,equip_pmr_vest,equip_pmr_douche,"
           "equip_pmr_sanit,equip_loc_type,equip_acces_handi_mobilite,equip_acces_handi_sensoriel,"
           "equip_obs,inst_obs,aps_name")
_SAFE_ERROR = "Le registre officiel des lieux d’accueil est temporairement indisponible. Réessayez dans quelques instants."
_NOTICE = "Lieu potentiel : aptitude, disponibilité et capacité de mise à l’abri à confirmer auprès du gestionnaire."


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read_json(url: str, *, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    request = Request(url, headers={"Accept": "application/json", "Accept-Encoding": "identity",
                                    "User-Agent": "OpeProtec/1.0 (official Data ES inventory)"})
    with urlopen(request, timeout=timeout) as response:
        length = response.headers.get("Content-Length")
        if length and int(length) > MAX_PAGE_BYTES:
            raise ValueError("Data ES page too large")
        chunks: list[bytes] = []
        size = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Data ES page deadline")
            raw_socket = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
            if raw_socket is not None:
                raw_socket.settimeout(min(remaining, SOCKET_TIMEOUT_SECONDS))
            read = getattr(response, "read1", response.read)
            chunk = read(min(64 * 1024, MAX_PAGE_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > MAX_PAGE_BYTES:
                raise ValueError("Data ES page too large")
    value = json.loads(b"".join(chunks))
    if not isinstance(value, dict):
        raise ValueError("Invalid Data ES response")
    return value


def _page(reader: Callable[..., Any], url: str, deadline: float) -> dict[str, Any]:
    for attempt in range(2):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Data ES collection deadline")
        try:
            value = reader(url, timeout=min(SOCKET_TIMEOUT_SECONDS, remaining))
            if time.monotonic() > deadline:
                raise TimeoutError("Data ES collection deadline")
            if not isinstance(value, dict):
                raise ValueError("Invalid Data ES page")
            return value
        except Exception as exc:
            transient = (exc.code in {408, 429, 500, 502, 503, 504} if isinstance(exc, HTTPError)
                         else isinstance(exc, (URLError, TimeoutError, ConnectionError, socket.timeout, IncompleteRead)))
            if attempt or not transient:
                raise
    raise ValueError("Missing Data ES page")


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _fold(value: Any) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", _text(value).lower())
                   if not unicodedata.combining(c))


def _bool(value: Any) -> str | None:
    if (isinstance(value, (bool, int, float)) and value == 1) or _fold(value) in {"true", "oui", "yes", "1"}:
        return "yes"
    if (isinstance(value, (bool, int, float)) and value == 0) or _fold(value) in {"false", "non", "no", "0"}:
        return "no"
    return None


def _number(value: Any, *, allow_zero: bool = False) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        result = float(str(value).replace(",", "."))
        return result if math.isfinite(result) and (result >= 0 if allow_zero else result > 0) else None
    except (ValueError, TypeError):
        return None


def _list(value: Any) -> list[str]:
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            value = parsed if isinstance(parsed, list) else [] if parsed is None else [value]
        except ValueError:
            value = [value]
    return list(dict.fromkeys(_text(item) for item in value if _text(item))) if isinstance(value, list) else []


def _date(value: Any) -> str | None:
    try:
        text = _text(value)
        datetime.fromisoformat(text.replace("Z", "+00:00"))
        return text
    except ValueError:
        return None


def _website(value: Any) -> str | None:
    text = _text(value)
    try:
        parsed = urlsplit(text)
        return text if parsed.scheme in {"http", "https"} and parsed.hostname and not parsed.username and not parsed.password else None
    except ValueError:
        return None


def _resource_type(row: dict[str, Any]) -> str | None:
    kind = _fold(row.get("equip_type_name"))
    # Permanent apparatus, climbing walls, ice, water and firing ranges cannot
    # be presented as a general-purpose room simply because they are indoors.
    if any(word in kind for word in ("bassin", "piscine", "glace", "escalade", "squash", "jorkyball",
                                     "musculation", "culturisme", "halterophilie", "billard", "trampoline")):
        return None
    if "polyvalent" in kind or "fetes" in kind or "non specialise" in kind:
        return "salle_fetes"
    if "multisports" in kind or "gymnase" in kind:
        return "gymnase"
    if "dojo" in kind or "arts martiaux" in kind or "boxe" in kind or "lutte" in kind or "escrime" in kind:
        return "salle_omnisports"
    if any(word in kind for word in ("danse", "cours collectifs", "gymnastique", "basket", "badminton", "tennis de table", "echecs")):
        return "salle_omnisports"
    return None


def _coordinates(row: dict[str, Any]) -> tuple[float, float] | None:
    coords = row.get("equip_coordonnees")
    coords = coords if isinstance(coords, dict) else {}
    lat = _number(coords.get("lat") if coords.get("lat") is not None else row.get("equip_y"))
    lon = _number(coords.get("lon") if coords.get("lon") is not None else row.get("equip_x"))
    if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


def _point(row: dict[str, Any], kind: str) -> dict[str, Any] | None:
    coordinate = _coordinates(row)
    if coordinate is None:
        return None
    identifier = _text(row.get("equip_numero"))
    record_url = "https://equipements.sports.gouv.fr/pages/fiche/?" + urlencode({"refine.equip_numero": identifier})
    pmr = {key: _bool(row.get(field)) for key, field in {
        "entrance": "equip_pmr_acc", "activity_area": "equip_pmr_aire", "paths": "equip_pmr_chem",
        "locker_rooms": "equip_pmr_vest", "showers": "equip_pmr_douche", "sanitary": "equip_pmr_sanit"}.items()}
    route = [pmr[key] for key in ("entrance", "paths", "activity_area")]
    accessibility = "no" if "no" in route else "yes" if all(value == "yes" for value in route) else None
    energies = _list(row.get("equip_energie"))
    # The source describes energy for heating *and cooling*. Fuel/gas/electricity
    # alone cannot confirm that a usable heating system is present.
    heating = "no" if any(_fold(value) in {"non chauffe", "aucun", "sans chauffage"} for value in energies) else None
    category = _number(row.get("equip_erp_cat"))
    category = int(category) if category is not None and category.is_integer() and 1 <= category <= 5 else None
    surface = _number(row.get("equip_surf"))
    municipality = _text(row.get("new_name"))
    address = " ".join(part for part in (_text(row.get("inst_adresse")), _text(row.get("inst_cp")), municipality) if part)
    name = _text(row.get("equip_nom")) or _text(row.get("inst_nom")) or "Salle recensée Data ES"
    details = ["Data ES · Ministère chargé des Sports", _text(row.get("equip_type_name")),
               f"Surface publiée : {surface:g} m²" if surface is not None else "Surface non renseignée",
               f"ERP catégorie {category}" if category else "Catégorie ERP non renseignée", _NOTICE]
    return {
        "id": "dataes-" + identifier, "equipment_id": identifier,
        "installation_id": _text(row.get("inst_numero")) or None,
        "installation_name": _text(row.get("inst_nom")) or None,
        "name": name, "type": kind, "equipment_type": _text(row.get("equip_type_name")),
        "lat": coordinate[0], "lon": coordinate[1], "active": True, "priority": "standard",
        "address": address or "Adresse non renseignée", "municipality": municipality or None,
        "municipality_code": _text(row.get("new_code")) or None, "postal_code": _text(row.get("inst_cp")) or None,
        "capacity": None, "capacity_source": None, "erp_category": category,
        "erp_capacity_min": None, "erp_capacity_max": None,
        "erp_capacity_label": f"ERP catégorie {category} (classement publié)" if category else None,
        "erp_types": _list(row.get("equip_erp_type")), "surface_m2": surface,
        "length_m": _number(row.get("equip_long")), "width_m": _number(row.get("equip_larg")),
        "height_m": _number(row.get("equip_haut")), "floor_material": _text(row.get("equip_sol")) or None,
        "accessibility": accessibility, "accessibility_details": pmr,
        "mobility_access": _text(row.get("equip_acces_handi_mobilite")) or None,
        "sensory_access": _text(row.get("equip_acces_handi_sensoriel")) or None,
        "sanitary": _bool(row.get("equip_sanit")), "shower": _bool(row.get("equip_douche")),
        "heating": heating, "energy_sources": energies, "parking": None,
        "locker_rooms": _number(row.get("equip_vest_sport"), allow_zero=True),
        "spectator_capacity": _number(row.get("equip_trib_nb"), allow_zero=True),
        "owner": _text(row.get("equip_prop_nom")) or _text(row.get("equip_prop_type")) or None,
        "owner_type": _text(row.get("equip_prop_type")) or None,
        "operator": _text(row.get("equip_gest_type")) or None, "phone": None, "email": None,
        "website": _website(row.get("equip_url")), "activities": _list(row.get("aps_name")),
        "additional_rooms": _list(row.get("equip_loc_type")),
        "opening_authorization": _bool(row.get("equip_ouv_public_bool")),
        "observations": _text(row.get("equip_obs")) or _text(row.get("inst_obs")) or None,
        "source": record_url, "record_url": record_url, "source_url": HOSTING_SOURCE_URL,
        "verified": True, "verified_source": "Data ES · Ministère chargé des Sports",
        "updated_at": _date(row.get("equip_maj_date")), "dynamic": True,
        "hosting_status": "à confirmer", "hosting_note": _NOTICE, "availability_notice": _NOTICE,
        "info": " | ".join(details),
    }


def collect_verified_hosting_isere(*, read_json: Callable[..., Any] | None = None, page_size: int = 100) -> dict[str, Any]:
    """Return a fully paginated official inventory, or a truthful unavailable result."""
    attempted_at = _utcnow()
    base = {"schema_version": HOSTING_SCHEMA_VERSION, "source": "Data ES · Ministère chargé des Sports",
            "source_url": HOSTING_SOURCE_URL, "last_attempt_at": attempted_at, "department": "Isère (38)"}
    try:
        if isinstance(page_size, bool) or not isinstance(page_size, int) or not 1 <= page_size <= 100:
            raise ValueError("Invalid Data ES page size")
        reader = read_json or _read_json
        deadline = time.monotonic() + MAX_DURATION_SECONDS
        total: int | None = None
        offset = 0
        rows_by_id: dict[str, dict[str, Any]] = {}
        previous_page_ids: set[str] = set()
        duplicates = 0
        for _ in range(MAX_PAGES):
            url = HOSTING_RECORDS_URL + "?" + urlencode({"where": _WHERE, "select": _FIELDS,
                                                           "limit": page_size, "offset": offset, "order_by": "equip_numero"})
            payload = _page(reader, url, deadline)
            page_total, rows = payload.get("total_count"), payload.get("results")
            if isinstance(page_total, bool) or not isinstance(page_total, int) or not 0 <= page_total <= MAX_ROWS:
                raise ValueError("Invalid Data ES record count")
            if not isinstance(rows, list) or len(rows) > page_size:
                raise ValueError("Invalid Data ES results")
            if total is None:
                total = page_total
            elif total != page_total:
                raise ValueError("Data ES changed during collection")
            if offset + len(rows) > total or (not rows and offset < total):
                raise ValueError("Incomplete Data ES pagination")
            page_ids: set[str] = set()
            for row in rows:
                if not isinstance(row, dict):
                    raise ValueError("Invalid Data ES record")
                identifier = _text(row.get("equip_numero"))
                if not identifier or _text(row.get("dep_code")) != "38" or _fold(row.get("equip_nature")) != "interieur":
                    raise ValueError("Data ES department or nature filter was not respected")
                if identifier in previous_page_ids:
                    raise ValueError("Data ES repeated an earlier page")
                if identifier in page_ids:
                    duplicates += 1
                else:
                    page_ids.add(identifier)
                    rows_by_id[identifier] = row
            previous_page_ids.update(page_ids)
            offset += len(rows)
            if offset == total:
                break
        else:
            raise ValueError("Data ES pagination limit")
        points: list[dict[str, Any]] = []
        missing_coordinates = 0
        for row in rows_by_id.values():
            kind = _resource_type(row)
            if kind is None or _bool(row.get("inst_hs_bool")) == "yes":
                continue
            point = _point(row, kind)
            if point is None:
                missing_coordinates += 1
            else:
                points.append(point)
        points.sort(key=lambda point: (_fold(point["municipality"]), _fold(point["name"]), point["id"]))
        observed_at = _utcnow()
        dates = [point["updated_at"] for point in points if point["updated_at"]]
        return {**base, "status": "online", "complete": True, "count": len(points), "points": points,
                "records_total": total, "equipment_total": len(points),
                "installations_total": len({point["installation_id"] or point["id"] for point in points}),
                "duplicate_records_total": duplicates, "missing_coordinates_total": missing_coordinates,
                "excluded_records_total": len(rows_by_id) - len(points) - missing_coordinates,
                "updated_at": observed_at, "last_success_at": observed_at,
                "resource_updated_at": max(dates) if dates else None,
                "note": "Inventaire de salles couvertes potentielles Data ES. Plusieurs équipements peuvent partager une installation. "
                        "Aucune capacité de couchage ni disponibilité de crise n’est publiée ; validation du gestionnaire nécessaire."}
    except Exception:
        return {**base, "status": "unavailable", "complete": False, "count": None, "points": [],
                "updated_at": None, "last_success_at": None, "error": _SAFE_ERROR}
