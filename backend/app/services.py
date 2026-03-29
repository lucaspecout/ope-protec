import asyncio
from datetime import datetime, timezone

import feedparser
import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .models import ExternalSnapshot

SOURCES = {
    "meteo_france": "https://vigilance.meteofrance.fr/fr/isere",
    "vigicrues": "https://www.vigicrues.gouv.fr/services/observations.json",
    "prefecture_isere_rss": "https://www.isere.gouv.fr/layout/set/print/var/ezdemo_site/storage/rss",
}


async def _fetch_meteo(client: httpx.AsyncClient) -> dict:
    resp = await client.get(SOURCES["meteo_france"])
    return {"http_status": resp.status_code, "url": str(resp.url)}


async def _fetch_vigicrues(client: httpx.AsyncClient) -> dict:
    resp = await client.get(SOURCES["vigicrues"])
    data = resp.json() if resp.status_code == 200 else {}
    return {
        "http_status": resp.status_code,
        "stations_count": len(data.get("data", [])) if isinstance(data, dict) else 0,
    }


async def _fetch_prefecture_rss(client: httpx.AsyncClient) -> dict:
    resp = await client.get(SOURCES["prefecture_isere_rss"])
    parsed = feedparser.parse(resp.text)
    entries = [{"title": e.get("title", ""), "link": e.get("link", "")} for e in parsed.entries[:5]]
    return {"http_status": resp.status_code, "items": entries}


async def collect_external_sources() -> dict[str, dict]:
    limits = httpx.Limits(max_connections=settings.external_max_connections)
    timeout = httpx.Timeout(settings.external_http_timeout_seconds)
    async with httpx.AsyncClient(limits=limits, timeout=timeout, follow_redirects=True) as client:
        tasks = {
            "meteo_france": _fetch_meteo(client),
            "vigicrues": _fetch_vigicrues(client),
            "prefecture_isere_rss": _fetch_prefecture_rss(client),
        }
        results: dict[str, dict] = {}
        for key, coro in tasks.items():
            try:
                payload = await coro
                results[key] = {"status": "ok", "payload": payload, "message": None}
            except Exception as exc:
                results[key] = {"status": "error", "payload": {}, "message": str(exc)}
        return results


def persist_external_results(db: Session, results: dict[str, dict]) -> None:
    now = datetime.now(timezone.utc)
    for source, result in results.items():
        db.add(
            ExternalSnapshot(
                source=source,
                status=result["status"],
                payload=result["payload"],
                message=result["message"],
                fetched_at=now,
            )
        )
    db.commit()


def latest_snapshots(db: Session) -> list[ExternalSnapshot]:
    snapshots: list[ExternalSnapshot] = []
    for source in SOURCES:
        row = db.execute(
            select(ExternalSnapshot)
            .where(ExternalSnapshot.source == source)
            .order_by(ExternalSnapshot.fetched_at.desc())
            .limit(1)
        ).scalar_one_or_none()
        if row:
            snapshots.append(row)
    return snapshots


async def refresh_and_persist(db: Session) -> dict[str, dict]:
    results = await collect_external_sources()
    persist_external_results(db, results)
    return results
