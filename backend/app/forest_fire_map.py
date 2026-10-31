"""Date of the prefecture publication, distinct from our collection time."""
from datetime import datetime, timezone
from html import unescape
import re
import unicodedata
from zoneinfo import ZoneInfo

PARIS = ZoneInfo("Europe/Paris")
MONTHS = {name: index for index, name in enumerate(
    ("janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"), 1)}


def _publication_date(value):
    value = value.strip()
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (stamp.astimezone(PARIS) if stamp.tzinfo else stamp).date()
    except ValueError:
        pass
    match = re.fullmatch(r"(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})", value)
    if match:
        day, month, year = map(int, match.groups())
    else:
        match = re.fullmatch(r"(\d{1,2})\s+([a-z]+)\s+(\d{4})", value)
        if not match or match[2] not in MONTHS:
            return None
        day, month, year = int(match[1]), MONTHS[match[2]], int(match[3])
    try:
        return datetime(year, month, day).date()
    except ValueError:
        return None


def publication_date(html):
    # Prefer the explicit update date displayed by the prefecture. Publication
    # dates, HTTP retrieval dates and image download times are not update dates.
    text = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", html, flags=re.I | re.S)
    text = unescape(re.sub(r"<[^>]+>", " ", text))
    text = "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c)).lower()
    text = re.sub(r"\s+", " ", text)
    match = re.search(r"mis(?:e)?\s+a\s+jour(?:\s+le)?\s*:?\s*(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}|\d{1,2}\s+[a-z]+\s+\d{4})", text)
    if match:
        return _publication_date(match[1])
    match = re.search(r'["\']dateModified["\']\s*:\s*["\']([^"\']+)', html, re.I)
    if match:
        return _publication_date(unescape(match[1]))
    for tag in re.findall(r"<meta\b[^>]*>", html, re.I):
        attrs = dict((key.lower(), unescape(value)) for key, _, value in re.findall(r'([\w:-]+)\s*=\s*(["\'])(.*?)\2', tag, re.S))
        if (attrs.get("property") or attrs.get("name") or attrs.get("itemprop") or "").lower() in {"article:modified_time", "datemodified", "dcterms.modified"}:
            return _publication_date(attrs.get("content", ""))
    return None


def publication_state(html, now=None):
    now = now or datetime.now(timezone.utc)
    date = publication_date(html)
    today = now.astimezone(PARIS).date()
    return {"status": "online" if date == today else "off_season" if date else "unavailable",
            "source_date": date.isoformat() if date else None,
            "checked_date": today.isoformat(),
            "message": "Carte officielle du jour" if date == today else "Hors saison — carte indisponible" if date else "Carte indisponible — date de mise à jour non vérifiable"}
