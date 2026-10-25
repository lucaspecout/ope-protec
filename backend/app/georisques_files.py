"""Official downloadable references, independent of the Géorisques API host."""
import csv
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen
from urllib.parse import urlencode
import xml.etree.ElementTree as ET
import zipfile

GASPAR_URL = 'https://files.georisques.fr/GASPAR/gaspar.zip'
RADON_URL = 'https://static.data.gouv.fr/resources/connaitre-le-potentiel-radon-de-ma-commune/20190506-174309/radon.csv'
SEISMIC_URL = 'https://datacarto.open-datara.fr/wfs/29605d2a-c46f-4fe5-bccb-72eeb4dd2194?service=WFS&version=2.0.0&request=GetFeature&typeNames=ms:n_alea_sismique_s_038&propertyName=insee,nom,code_zone,zone_sism&count=1000'
SEISMIC_SOURCE = 'https://www.data.gouv.fr/datasets/6863a7e83492920481cfef5b'
BUNDLE = Path(__file__).with_name('data') / 'georisques_isere_reference.json'
BRGM_URL = 'https://mapsref.brgm.fr/wxs/georisques/risques'
BRGM_FIELDS = {'MVT_LOCALISE': 'num_insee,id_mvt,type_mvt,lieu_dit,fiabilite,date_deb_mvt,date_maj',
               'CAVITE_LOCALISEE': 'num_insee,identifiant,nom_cavite,type_cavite,reperage_geographique,date_validite'}


def download(url):
    with urlopen(Request(url, headers={'User-Agent': 'ope-protec/1.0'}), timeout=15) as response:
        raw = response.read(20 * 1024 * 1024 + 1)
    if len(raw) > 20 * 1024 * 1024:
        raise ValueError('Official export too large')
    return raw


def dataset(rows, source, data_date):
    return {'content': rows, 'total_elements': len(rows), 'status': 'fallback', 'source': source,
            'data_date': data_date, 'updated_at': datetime.now(timezone.utc).isoformat()}


def parse_gaspar(raw):
    result = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for prefix, key in [('ddrm_risq', 'risques'), ('azi', 'azi'), ('dicrim', 'dicrim'), ('tim', 'tim'), ('pprn', 'pprn'), ('pprm', 'pprm'), ('pprt', 'pprt')]:
            candidates = [x for x in archive.infolist() if x.filename.startswith(prefix + '_gaspar_') and x.filename.endswith('.csv')]
            if len(candidates) != 1:
                continue  # Missing member is unknown, never a successful empty list.
            entry = candidates[0]
            if entry.file_size > 45 * 1024 * 1024:
                raise ValueError('Official CSV too large')
            match = re.search(r'(\d{4}-\d{2}-\d{2})', entry.filename)
            data_date = match.group(1) if match else None
            by_id = {}
            rows = []
            with archive.open(entry) as stream:
                reader = csv.DictReader(io.TextIOWrapper(stream, encoding='utf-8-sig'), delimiter=';')
                headers = set(reader.fieldnames or [])
                expected = 'CODE INSEE COMMUNE' if prefix.startswith('ppr') else 'code_commune' if prefix == 'tim' else 'cod_commune'
                if expected not in headers:
                    raise ValueError('Unknown official CSV schema')
                for row in reader:
                    code = row.get(expected, '').strip()
                    if len(code) != 5 or not code.startswith('38'):
                        continue
                    name = row.get('lib_commune') or row.get('libelle_commune') or row.get('NOM COMMUNE')
                    if prefix == 'ddrm_risq':
                        rows.append({'codeInsee': code, 'libelle': row['lib_risque'], 'communes': [{'codeInsee': code, 'nom': name, 'aleas': [{'libelle': row['lib_risque']}]}]})
                    elif prefix == 'dicrim':
                        rows.append({'codeInsee': code, 'libelleCommune': name, 'anneePublication': row['dat_publi_dicrim'][:4] or None})
                    elif prefix == 'tim':
                        rows.append({'codeInsee': code, 'libelle': 'Transmission d’information au maire', 'dateTransmission': row.get('date_transmission', '')[:10], 'communes': [{'codeInsee': code, 'nom': name}]})
                    else:
                        ppr = prefix.startswith('ppr')
                        identifier = row['CODE PROCEDURE'] if ppr else row['id_gaspar']
                        if identifier not in by_id:
                            by_id[identifier] = {'idGaspar': identifier, 'libPpr' if ppr else 'libelle': row['LIBELLE PROCEDURE'] if ppr else row['libelle'],
                                                'libBassinRisques': row.get('BASSIN RISQUE') if ppr else row.get('lib_bassin_risques'),
                                                'dateModification': row.get('DATE DERNIERE MISE A JOUR') if ppr else row.get('date_modification', '')[:10], 'communes': []}
                        commune = {'codeInsee': code, 'nom': name}
                        if ppr:
                            commune.update(etat=row.get('LIBELLE ETAT'), dateEtat=row.get('DATE ETAT'), aleas=[{'libelle': row[f'LIBELLE RISQUE {n}']} for n in (1, 2, 3) if row.get(f'LIBELLE RISQUE {n}')])
                        if commune not in by_id[identifier]['communes']:
                            by_id[identifier]['communes'].append(commune)
            result['gaspar/' + key] = dataset(list(by_id.values()) if by_id else rows, GASPAR_URL, data_date)
    return result


def parse_radon(raw):
    reader = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')), delimiter=';')
    if not {'insee_com', 'classe_potentiel', 'nom_comm'} <= set(reader.fieldnames or []):
        raise ValueError('Unknown radon CSV schema')
    rows = [{'codeInsee': r['insee_com'], 'libelleCommune': r['nom_comm'], 'classePotentiel': r['classe_potentiel']} for r in reader if r['insee_com'].startswith('38') and r['classe_potentiel'] in ('1', '2', '3')]
    if not rows:
        raise ValueError('Empty radon reference')
    return {'radon': dataset(rows, 'https://www.data.gouv.fr/datasets/connaitre-le-potentiel-radon-de-ma-commune', '2019-05-06')}


def parse_seismic(raw):
    root = ET.fromstring(raw)
    rows = []
    if int(root.attrib.get('numberMatched', 0)) > 1000:
        raise ValueError('Incomplete seismic reference')
    for node in root.iter():
        if node.tag.rsplit('}', 1)[-1] != 'n_alea_sismique_s_038':
            continue
        props = {c.tag.rsplit('}', 1)[-1]: c.text for c in node}
        code = str(props.get('insee') or '')
        zone = str(props.get('code_zone') or '')
        if code.startswith('38') and len(code) == 5 and zone in ('1', '2', '3', '4', '5'):
            rows.append({'codeInsee': code, 'zoneSismicite': zone, 'typeZone': props.get('zone_sism')})
    if not rows:
        raise ValueError('Empty seismic reference')
    return {'zonage_sismique': dataset(rows, SEISMIC_SOURCE, None)}


def load_brgm(layer, get):
    """MapServer caps responses at 500 regardless of COUNT; read every page."""
    filter_xml = '<Filter xmlns="http://www.opengis.net/fes/2.0"><PropertyIsLike wildCard="*" singleChar="?" escapeChar="!"><ValueReference>num_insee</ValueReference><Literal>38*</Literal></PropertyIsLike></Filter>'
    rows, seen, consumed = [], set(), 0
    for page in range(100):
        query = {'SERVICE': 'WFS', 'VERSION': '2.0.0', 'REQUEST': 'GetFeature', 'TYPENAMES': 'ms:' + layer,
                 'PROPERTYNAME': BRGM_FIELDS[layer], 'COUNT': 500, 'STARTINDEX': page * 500, 'FILTER': filter_xml,
                 'SORTBY': 'id_mvt' if layer == 'MVT_LOCALISE' else 'identifiant'}
        raw = get(BRGM_URL + '?' + urlencode(query))
        consumed += len(raw)
        if consumed > 20 * 1024 * 1024:
            raise ValueError('BRGM reference too large')
        root = ET.fromstring(raw)
        if root.tag.rsplit('}', 1)[-1] != 'FeatureCollection':
            raise ValueError('Invalid BRGM feature response')
        items = [{c.tag.rsplit('}', 1)[-1]: c.text for c in n} for n in root.iter() if n.tag.rsplit('}', 1)[-1] == layer]
        for item in items:
            code = str(item.get('num_insee') or '')
            identifier = item.get('id_mvt') if layer == 'MVT_LOCALISE' else item.get('identifiant')
            if not identifier or identifier in seen or not code.startswith('38') or len(code) != 5:
                raise ValueError('Unexpected or repeated BRGM feature')
            seen.add(identifier)
            if layer == 'MVT_LOCALISE':
                rows.append({'codeInsee': code, 'identifiant': identifier, 'type': 'Code BRGM ' + str(item.get('type_mvt') or 'non renseigné'),
                             'lieu': item.get('lieu_dit'), 'fiabilite': 'Code BRGM ' + str(item.get('fiabilite') or 'non renseigné'),
                             'dateDebut': item.get('date_deb_mvt'), 'dateMaj': item.get('date_maj')})
            else:
                rows.append({'codeInsee': code, 'identifiant': identifier, 'nom': item.get('nom_cavite'), 'type': item.get('type_cavite'),
                             'reperageGeographique': item.get('reperage_geographique'), 'dateMaj': item.get('date_validite')})
        if len(items) < 500 and not root.attrib.get('next'):
            if not rows:
                raise ValueError('Empty department inventory')
            key = 'mvt' if layer == 'MVT_LOCALISE' else 'cavites'
            return {key: {**dataset(rows, BRGM_URL, None), 'coverage_note': 'Inventaire des éléments localisés du BRGM. Les éléments non localisés ne sont pas inclus.'}}
    raise ValueError('BRGM pagination limit exceeded')


def load_references(read_cache, write_cache, get=download):
    cached = read_cache('georisques_references.json') or {}
    try:
        if cached.get('checked_at') and (datetime.now(timezone.utc) - datetime.fromisoformat(cached['checked_at'])).total_seconds() < 86400:
            return cached.get('datasets') or {}
    except (ValueError, TypeError):
        pass
    try:
        bundled = json.loads(BUNDLE.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        bundled = {}
    result = {**bundled.get('datasets', {}), **cached.get('datasets', {})}
    for url, parser in [(GASPAR_URL, parse_gaspar), (RADON_URL, parse_radon), (SEISMIC_URL, parse_seismic)]:
        try:
            result.update(parser(get(url)))
        except Exception:
            pass  # Retain dated references; do not replace them with empty data.
    for layer in BRGM_FIELDS:
        try:
            result.update(load_brgm(layer, get))
        except Exception:
            pass
    write_cache('georisques_references.json', {'checked_at': datetime.now(timezone.utc).isoformat(), 'datasets': result})
    return result
