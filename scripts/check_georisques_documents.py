"""Explicit live audit of curated official document links (not a unit test)."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.georisques_documents import document_catalog, DDRM_URL, GUIDE_URL

def check(item):
    url, is_pdf = item
    try:
        with urlopen(Request(url, headers={'User-Agent':'ope-protec/1.0'}), timeout=12) as response:
            prefix = response.read(5)
            return {'url':url, 'status':response.status, 'pass':response.status==200 and (not is_pdf or prefix==b'%PDF-')}
    except HTTPError as error:
        return {'url':url, 'status':error.code, 'pass':False}
    except Exception as error:
        return {'url':url, 'error':type(error).__name__, 'pass':False}

if __name__=='__main__':
    links = {(d['url'], d['format']=='pdf') for rows in document_catalog().values() for d in rows}
    links.update([(DDRM_URL,True),(GUIDE_URL,False)])
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(check, sorted(links)))
    print(json.dumps({'results':results}, ensure_ascii=False, indent=2))
    raise SystemExit(0 if all(r['pass'] for r in results) else 1)
