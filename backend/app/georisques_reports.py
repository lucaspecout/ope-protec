"""Read the same public summary as the official commune report, with a daily cache."""
from datetime import datetime, timezone
from html import unescape
import json
from pathlib import Path
import re
from http.cookiejar import CookieJar
from urllib.parse import quote, urlencode, urljoin, urlsplit
from urllib.request import Request, build_opener, HTTPCookieProcessor
from time import sleep
from html.parser import HTMLParser

BASE = 'https://www.georisques.gouv.fr'
BUNDLE = Path(__file__).with_name('data') / 'georisques_reports.json'
SOURCE_PATH = '/mes-risques/connaitre-les-risques-pres-de-chez-moi/rapport2/'

class DicrimLinks(HTMLParser):
    def __init__(self, code):
        super().__init__()
        self.code, self.links = code, []
    def handle_starttag(self, tag, attrs):
        if tag != 'a':
            return
        href = dict(attrs).get('href', '')
        target = urlsplit(urljoin(BASE, href))
        valid_page = target.netloc == 'www.georisques.gouv.fr' and target.path == '/DICRIM/' + self.code
        valid_file = target.netloc == 'files.georisques.fr' and target.path == '/DICRIM/DICRIM_' + self.code + '.pdf'
        if target.scheme == 'https' and (valid_page or valid_file):
            link = target.geturl()
            if link not in self.links:
                self.links.append(link)

def discover_dicrim(page, code, opener):
    parser = DicrimLinks(code)
    parser.feed(page)
    result = []
    for url in parser.links[:2]:
        try:
            with opener.open(Request(url, headers={'User-Agent':'ope-protec/1.0'}), timeout=10) as response:
                if response.read(5) != b'%PDF-':
                    continue
            result.append({'kind':'DICRIM', 'title':'DICRIM publié sur Géorisques', 'url':url, 'format':'pdf',
                           'publisher':'Géorisques / commune', 'code_insee':code, 'scope':'commune',
                           'discovery':'official_report', 'verified_at':datetime.now(timezone.utc).date().isoformat()})
        except Exception:
            continue
    return result

def canonical_report(code, identity):
    if not re.fullmatch(r'38\d{3}', code) or not identity.get('name') or not re.fullmatch(r'\d{5}', str(identity.get('postal_code') or '')):
        raise ValueError('Missing commune identity')
    return BASE + SOURCE_PATH + '/'.join(quote(str(v), safe='') for v in (code, identity['name'], 'commune', identity['postal_code']))

def normalize_report(payload, code, source):
    risks = payload.get('risks') if isinstance(payload, dict) else None
    if not isinstance(risks, dict) or str(risks.get('cityCode') or '') != code or risks.get('hasAdresse') is not False or risks.get('type') != 'commune':
        raise ValueError('Report identity or scope mismatch')
    groups = risks.get('listRisqueType')
    if not isinstance(groups, list) or len(groups) != 2:
        raise ValueError('Incomplete official risk groups')
    output = {}
    for index, key in enumerate(('natural', 'technological')):
        if ('naturel' if index == 0 else 'technolog') not in str(groups[index].get('title') or '').lower():
            raise ValueError('Official risk group ordering changed')
        rows = groups[index].get('listRisqueResume')
        if not isinstance(rows, list) or len(rows) != groups[index].get('sizeList') or payload.get('nat' if index == 0 else 'techno', {}).get('count') != len(rows):
            raise ValueError('Official risk count mismatch')
        entries, seen = [], set()
        for row in rows:
            risk_code = str(row.get('code') or '')
            if not re.fullmatch(r'[A-Z0-9_]{2,30}', risk_code) or risk_code in seen or not row.get('title') or not row.get('libelleStatusMunicipality'):
                raise ValueError('Invalid official risk entry')
            seen.add(risk_code)
            entries.append({'code': risk_code, 'title': row.get('title'), 'label': row.get('legendeCode') or row['title'],
                            'status_label': row['libelleStatusMunicipality'], 'description': unescape(re.sub('<[^>]*>', ' ', str(row.get('description') or '')))})
        output[key] = entries
        output[key + '_total'] = len(entries)
    return {**output, 'schema_version':2, 'code_insee': code, 'scope': 'commune', 'status': 'online', 'source': source, 'updated_at': datetime.now(timezone.utc).isoformat()}

def fetch_report(code, identity, opener=None, pause=sleep):
    opener = opener or build_opener(HTTPCookieProcessor(CookieJar()))
    url = canonical_report(code, identity)
    def read(request):
        with opener.open(request, timeout=15) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('Report too large')
        return raw
    for _ in range(3):
        page = read(Request(url, headers={'User-Agent':'ope-protec/1.0'})).decode('utf-8')
        match = re.search(r'data-risks-api-params="([^"]+)"', page)
        if not match:
            raise ValueError('Official report parameters unavailable')
        pause(1.05)
        request = Request(BASE + '/mes-risques/rapport/all-risks',
                          data=urlencode({'all_risks_api_params': unescape(match.group(1))}).encode(),
                          headers={'User-Agent':'ope-protec/1.0','Content-Type':'application/x-www-form-urlencoded','Referer':url,'X-Requested-With':'XMLHttpRequest'})
        payload = json.loads(read(request))
        if payload.get('redirectUrl'):
            target = urljoin(BASE, payload['redirectUrl'])
            if urlsplit(target).netloc != 'www.georisques.gouv.fr' or urlsplit(target).scheme != 'https' or not urlsplit(target).path.startswith(SOURCE_PATH + code + '/'):
                raise ValueError('Unexpected report redirect')
            url = target
            continue
        result = normalize_report(payload, code, url)
        result['documents'] = discover_dicrim(page, code, opener)
        return result
    raise ValueError('Official report redirect loop')

def load_report(code, identity, read_cache, write_cache, fetch=fetch_report):
    key = 'georisques_report_' + code + '.json'
    old = read_cache(key) or {}
    try:
        timestamp = old.get('checked_at') if old.get('status') != 'online' else old.get('updated_at')
        ttl = 900 if old.get('status') != 'online' else 86400
        compatible = old.get('status') != 'online' or old.get('schema_version') == 2
        if compatible and old.get('code_insee') == code and (datetime.now(timezone.utc) - datetime.fromisoformat(timestamp)).total_seconds() < ttl:
            return old
    except (ValueError, KeyError, TypeError):
        pass
    try:
        bundled = json.loads(BUNDLE.read_text(encoding='utf-8')).get(code) or {}
    except (OSError, ValueError):
        bundled = {}
    fallback = old if old.get('code_insee') == code else bundled
    try:
        result = fetch(code, identity)
        write_cache(key, result)
        return result
    except Exception:
        result = {**fallback, 'code_insee':code, 'checked_at':datetime.now(timezone.utc).isoformat(), 'status': 'stale' if fallback.get('updated_at') else 'unavailable', 'error':'Rapport officiel momentanément indisponible. Les inventaires ne constituent pas son décompte complet.'}
        write_cache(key, result)
        return result
