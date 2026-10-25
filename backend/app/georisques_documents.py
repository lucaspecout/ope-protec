"""Commune identity and explicitly sourced public risk documents."""
from functools import lru_cache
import json
from pathlib import Path
import re
from datetime import datetime, timezone
from urllib.request import urlopen, Request

DATA = Path(__file__).with_name('data')
DDRM_URL = 'https://www.isere.gouv.fr/contenu/telechargement/51404/350682/file/Trium_DDRM_2020_V11_finale.pdf'
GUIDE_URL = 'https://www.isere.gouv.fr/Actions-de-l-Etat/Risques-majeurs/Tous-publics/Je-me-protege-en-famille/Fiches-pratiques-sur-les-risques-majeurs'

@lru_cache(maxsize=1)
def identities():
    return json.loads((DATA / 'georisques_communes.json').read_text(encoding='utf-8'))

@lru_cache(maxsize=1)
def document_catalog():
    return json.loads((DATA / 'georisques_documents.json').read_text(encoding='utf-8'))

def fetch_identity(code):
    if not re.fullmatch(r'38\d{3}', code):
        raise ValueError('Invalid commune code')
    url = f'https://geo.api.gouv.fr/communes/{code}?fields=nom,code,codesPostaux,centre&format=json'
    with urlopen(Request(url, headers={'User-Agent':'ope-protec/1.0'}), timeout=10) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise ValueError('Commune identity too large')
    row = json.loads(raw)
    if str(row.get('code')) != code or not row.get('nom') or not row.get('codesPostaux'):
        raise ValueError('Commune identity mismatch')
    coordinates = (row.get('centre') or {}).get('coordinates') or [None,None]
    return {'name':row['nom'], 'postal_code':row['codesPostaux'][0], 'latitude':coordinates[1], 'longitude':coordinates[0], 'updated_at':datetime.now(timezone.utc).isoformat()}

def resolve_identity(code, read_cache, write_cache, fetch=fetch_identity):
    key = 'georisques_identity_' + code + '.json'
    old = read_cache(key) or {}
    try:
        if (datetime.now(timezone.utc) - datetime.fromisoformat(old['updated_at'])).total_seconds() < 86400:
            return old
    except (KeyError, ValueError, TypeError):
        pass
    try:
        identity = fetch(code)
        write_cache(key, identity)
        return identity
    except Exception:
        return old or identities().get(code, {})

def enrich_commune(commune, identity=None):
    code = str(commune.get('code_insee') or '')
    if not re.fullmatch(r'38\d{3}', code):
        return commune
    identity = identity if identity is not None else identities().get(code, {})
    commune.update(official_name=identity.get('name'), postal_code=identity.get('postal_code'),
                   latitude=identity.get('latitude'), longitude=identity.get('longitude'))
    datasets = commune.get('datasets') or {}
    automatic = (commune.get('official_report') or {}).get('documents') or []
    documents = [dict(row, scope='commune') for row in automatic if row.get('code_insee') == code]
    # Previously verified municipal PDFs are additional offline references only.
    documents.extend(dict(row, code_insee=code, scope='commune', discovery='previously_verified') for row in document_catalog().get(code, []) if row.get('url') not in {d.get('url') for d in documents})
    for kind in ('pprn', 'pprm', 'pprt'):
        for row in (datasets.get('gaspar/' + kind) or {}).get('content', []):
            identifier = str(row.get('idGaspar') or '')
            if not re.fullmatch(r'[A-Za-z0-9_-]{5,50}', identifier):
                continue
            local = [c for c in row.get('communes', []) if str(c.get('codeInsee')) == code]
            if not local:
                continue
            state = local[0].get('etat')
            state_label = state.get('libelle') if isinstance(state, dict) else state
            state_date = local[0].get('dateEtat') or (state.get('date') if isinstance(state, dict) else None)
            documents.append({'kind': kind.upper(), 'title': row.get('libPpr') or identifier, 'code_insee': code, 'scope': 'commune',
                              'url': f'https://www.georisques.gouv.fr/donnee-risques/PPR/Fiche-ppr/{kind}/{identifier}',
                              'format': 'page', 'publisher': 'Géorisques / services de l’État', 'reference': identifier,
                              'updated_at': row.get('dateModification'), 'state': state_label, 'state_date': state_date})
    documents.extend([
        {'kind': 'DDRM', 'title': 'Dossier départemental des risques majeurs — Isère', 'url': DDRM_URL, 'format': 'pdf', 'year': '2020', 'scope': 'department', 'publisher': 'Préfecture de l’Isère'},
        {'kind': 'GUIDE', 'title': 'Fiches pratiques : les bons réflexes face aux risques', 'url': GUIDE_URL, 'format': 'page', 'scope': 'department', 'publisher': 'Préfecture de l’Isère'},
    ])
    commune['documents'] = documents
    dicrim = datasets.get('gaspar/dicrim') or {}
    commune['dicrim'] = {'status': 'document_available' if any(d['kind'] == 'DICRIM' for d in documents) else 'listed' if dicrim.get('content') else 'not_verified',
                        'publication_year': commune.get('dicrim_publication_year'),
                        'note': 'Un document recensé dans GASPAR ne garantit pas un PDF public. Les liens municipaux identifiés sont présentés séparément.'}
    return commune
