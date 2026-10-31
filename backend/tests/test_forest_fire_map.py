"""Publication day controls whether the prefecture fire map can be displayed."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from html import unescape
import re
from pathlib import Path
import sys
from threading import Lock
import unittest
from unittest.mock import Mock
from urllib.parse import urljoin, unquote
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.forest_fire_map import publication_date, publication_state
from test_shared_risk_snapshots import load_definitions

NOW = datetime(2026, 10, 31, 12, tzinfo=timezone.utc)


class PublicationTests(unittest.TestCase):
    def test_explicit_french_update_dates(self):
        for html in ('<p>Mis à jour le <span>31/10/2026</span></p>', 'Mise à jour : 31 octobre 2026'):
            state = publication_state(html, NOW)
            self.assertEqual(state['status'], 'online')
            self.assertEqual(state['source_date'], '2026-10-31')

    def test_stale_or_future_dates_are_not_todays_map(self):
        for date in ('30/10/2026', '01/11/2026', '01/08/2026'):
            result = publication_state('Mis à jour le '+date, NOW)
            self.assertEqual(result['status'], 'off_season')
            self.assertEqual(result['message'], 'Hors saison — carte indisponible')

    def test_unknown_invalid_and_publication_dates_are_unavailable(self):
        for html in ('Publié le 31/10/2026', '<p>Sans date</p>', 'Mis à jour le 31/02/2026'):
            self.assertEqual(publication_state(html, NOW)['status'], 'unavailable')

    def test_modified_metadata_supports_paris_day_and_displayed_date_has_priority(self):
        now = datetime(2026, 7, 31, 22, 10, tzinfo=timezone.utc)
        html = '<script type="application/ld+json">{"dateModified":"2026-07-31T22:01:00Z"}</script>'
        self.assertEqual(publication_state(html, now)['source_date'], '2026-08-01')
        self.assertEqual(publication_state(html, now)['status'], 'online')
        self.assertEqual(publication_state(html+'<p>Mis à jour le 31/07/2026</p>', now)['status'], 'off_season')
        self.assertEqual(publication_date('<meta content="2026-10-31T10:00:00+01:00" property="article:modified_time">').isoformat(), '2026-10-31')


class CollectorTests(unittest.TestCase):
    def setUp(self):
        class Clock(datetime):
            current = NOW.replace(tzinfo=None)
            @classmethod
            def utcnow(cls):
                return cls.current
        self.clock = Clock
        self.reader = Mock()
        env = dict(datetime=Clock, timedelta=timedelta, deepcopy=deepcopy, re=re, ZoneInfo=ZoneInfo,
                   publication_state=publication_state, unescape=unescape, unquote=unquote, urljoin=urljoin,
                   _FOREST_FIRE_MAP_PAGE_URL='https://www.isere.gouv.fr/map',
                   _forest_fire_map_cache={'payload':None, 'expires_at':datetime.min},
                   _forest_fire_map_cache_lock=Lock(), _http_get_text=self.reader)
        self.env = load_definitions('services.py', {'fetch_forest_fire_map_isere'}, env)
        self.fetch = env['fetch_forest_fire_map_isere']

    def html(self, date):
        return f'<p>Mis à jour le {date}</p><img src="/alea-incendie_imagefull.jpg">'

    def test_collector_exposes_actual_date_and_no_stale_assets(self):
        self.reader.return_value = self.html('31/10/2026')
        current = self.fetch()
        self.assertEqual(current['status'], 'online')
        self.assertEqual(current['updated_at'], '2026-10-31')
        self.assertTrue(current['image_url'])
        self.reader.return_value = self.html('30/10/2026')
        stale = self.fetch(force_refresh=True)
        self.assertEqual(stale['status'], 'off_season')
        self.assertIsNone(stale['image_url'])
        self.assertIsNone(stale['pdf_url'])

    def test_expired_day_invalidates_otherwise_fresh_cache(self):
        self.clock.current = datetime(2026, 10, 30, 22, 55)
        self.reader.return_value = self.html('30/10/2026')
        self.assertEqual(self.fetch()['status'], 'online')
        self.clock.current = datetime(2026, 10, 30, 23, 1)
        self.reader.return_value = self.html('30/10/2026')
        self.assertEqual(self.fetch()['status'], 'off_season')
        self.assertEqual(self.reader.call_count, 2)

    def test_unavailable_is_distinct_from_off_season(self):
        self.reader.side_effect = RuntimeError('upstream unavailable')
        result = self.fetch()
        self.assertEqual(result['status'], 'unavailable')
        self.assertIsNone(result['updated_at'])
        self.assertIsNone(result['image_url'])


if __name__ == '__main__':
    unittest.main()
