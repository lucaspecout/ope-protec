"""Build a partial, explicitly scoped Géorisques snapshot from independent feeds."""
from datetime import datetime, timezone
from copy import deepcopy
from urllib.parse import urlencode
from time import sleep
import re


def failure_message(error):
    code = getattr(error, 'code', None)
    match = re.search(r'HTTP\s*(\d{3})', str(error))
    code = code or (int(match.group(1)) if match else None)
    if code in (401, 403):
        return 'Jeton refusé par Géorisques (HTTP %s) : vérifier sa validité et les droits API v2' % code
    if code == 429:
        return 'Quota Géorisques dépassé (HTTP 429)'
    if code:
        return 'Erreur du serveur Géorisques (HTTP %s)' % code
    if isinstance(error, (ConnectionError, TimeoutError, OSError)) or 'Connexion au fournisseur' in str(error):
        return 'Connexion à Géorisques interrompue ou impossible depuis le serveur'
    if 'Clé API' in str(error):
        return 'Clé API Géorisques v2 à configurer'
    return 'Réponse Géorisques invalide ou indisponible'

THEMES = {
    "mvt": "Mouvements de terrain", "cavites": "Cavités souterraines",
    "radon": "Potentiel radon", "gaspar/azi": "Atlas des zones inondables",
    "gaspar/pprn": "Plans de prévention naturels", "gaspar/pprm": "Plans de prévention miniers",
    "gaspar/pprt": "Plans de prévention technologiques", "gaspar/dicrim": "DICRIM",
    "gaspar/tim": "Transmission d’information au maire", "gaspar/risques": "Risques recensés",
    "gaspar/papi": "Programmes de prévention des inondations", "gaspar/tri": "Territoires à risque important d’inondation",
}


def collect_public_risks(codes, get):
    codes = list(dict.fromkeys(str(c) for c in codes if str(c).isdigit() and len(str(c)) == 5))
    entries = {c: {"code_insee": c, "risks": [], "risk_total": None, "danger_level": "Non évalué", "status": "unavailable"} for c in codes}
    for offset in range(0, len(codes), 10):
        batch = codes[offset:offset + 10]
        found = {c: set() for c in batch}
        try:
            for page in range(1, 101):
                sleep(0.21)
                query = urlencode({"code_insee": ",".join(batch), "page": page, "page_size": 100})
                payload = get("https://www.georisques.gouv.fr/api/v1/gaspar/risques?" + query)
                if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
                    raise ValueError("Invalid GASPAR response")
                for row in payload["data"]:
                    code = str(row.get("code_insee") or "")
                    if code in found:
                        for risk in row.get("risques_detail") or []:
                            label = risk.get("libelle_risque_long") or risk.get("libelle_risque")
                            if label:
                                found[code].add(str(label))
                if page >= int(payload.get("total_pages") or 1):
                    break
            else:
                raise ValueError("GASPAR pagination limit exceeded")
            for code, risks in found.items():
                entries[code].update(risks=sorted(risks), risk_total=len(risks), status="online")
        except Exception:
            for code in batch:
                entries[code]["errors"] = ["Source GASPAR temporairement indisponible"]
    failed = any(e["status"] != "online" for e in entries.values())
    return {"service": "Géorisques", "source": "https://www.georisques.gouv.fr/api/v1/gaspar/risques", "status": "degraded" if failed else "online",
            "communes": list(entries.values()), "error": "Données GASPAR incomplètes" if failed else None,
            "updated_at": datetime.now(timezone.utc).isoformat()}


def collect_summary(codes, token, fetch, previous=None, public_get=None, reference_loader=None):
    now = datetime.now(timezone.utc).isoformat()
    previous = previous or {}
    if not codes:
        return {"service": "Géorisques", "status": "degraded", "datasets": {}, "monitored_communes": [], "errors": ["Référentiel des communes indisponible"], "updated_at": now}
    datasets, errors, api_errors, recovered = {}, [], [], []
    references = None
    blocked = None

    def reference(endpoint, wanted):
        nonlocal references
        if references is None:
            references = reference_loader() if reference_loader else {}
        data = references.get(endpoint)
        if not data:
            return None
        content = []
        for row in data.get('content', []):
            if row.get('codeInsee') in wanted:
                content.append(deepcopy(row))
            elif any(c.get('codeInsee') in wanted for c in row.get('communes', [])):
                item = deepcopy(row)
                item['communes'] = [c for c in item['communes'] if c.get('codeInsee') in wanted]
                content.append(item)
        return {**data, 'content': content, 'total_elements': len(content)}

    def api_fetch(endpoint, **kwargs):
        nonlocal blocked
        if blocked:
            raise blocked
        try:
            return fetch(endpoint, **kwargs)
        except Exception as error:
            reason = failure_message(error)
            if reason.startswith(('Jeton refusé', 'Connexion à')):
                blocked = error
            raise

    for endpoint, label in THEMES.items():
        old = ((previous.get("datasets") or {}).get(endpoint) or {}) if previous.get("scope_codes") == sorted(codes) else {}
        try:
            if not token:
                raise ValueError("Clé API Géorisques v2 à configurer")
            data = api_fetch(endpoint, extra_query={"codesInsee": sorted(codes)}, token=token)
            datasets[endpoint] = {**data, "label": label, "status": "online", "updated_at": now}
        except Exception as error:
            message = failure_message(error)
            api_errors.append(f"{label} : {message}")
            backup = reference(endpoint, set(codes))
            if backup is not None:
                datasets[endpoint] = {**backup, 'label': label, 'api_error': message}
                recovered.append(label)
            else:
                errors.append(f"{label} : {message}")
                datasets[endpoint] = {**deepcopy(old), "label": label, "status": "stale" if old.get("updated_at") else "unavailable", "error": message, "checked_at": now}

    def rows(endpoint):
        return datasets[endpoint].get("content") or []

    def count(endpoint):
        return datasets[endpoint].get("total_elements")

    public = collect_public_risks(list(codes), public_get) if public_get and datasets['gaspar/risques'].get('total_elements') is None else {}
    public_by_code = {row['code_insee']: row for row in public.get('communes', [])}
    monitored = []
    for code, name in codes.items():
        def local(endpoint):
            return [r for r in rows(endpoint) if str(r.get("codeInsee") or "") == code or any(str(c.get("codeInsee") or "") == code for c in r.get("communes") or [])]
        local_data = {}
        for endpoint, data in datasets.items():
            # PPR list DTOs do not identify communes: never attribute a batch to one town.
            if endpoint.startswith("gaspar/ppr") and not any(r.get('communes') for r in data.get('content', [])):
                continue
            local_data[endpoint] = {**data, "content": local(endpoint), "total_elements": len(local(endpoint)) if data.get("total_elements") is not None else None}
        old_commune = next((c for c in previous.get("monitored_communes", []) if c.get("code_insee") == code), {})
        try:
            if not token:
                raise ValueError("missing token")
            seismic = api_fetch("zonage_sismique", extra_query={"codesInsee": [code]}, token=token)
            local_data["zonage_sismique"] = {**seismic, "label": "Zonage sismique", "status": "online", "updated_at": now}
        except Exception as error:
            old = (old_commune.get("datasets") or {}).get("zonage_sismique") or {}
            backup = reference('zonage_sismique', {code})
            if backup and backup['content']:
                local_data['zonage_sismique'] = {**backup, 'label': 'Zonage sismique', 'api_error': failure_message(error)}
                recovered.append(f'{name} : zonage sismique')
            else:
                local_data["zonage_sismique"] = {**deepcopy(old), "label": "Zonage sismique", "status": "stale" if old.get("updated_at") else "unavailable", "error": failure_message(error)}
                errors.append(f"{name} : {failure_message(error)}")
        radon = local("radon")
        risks = sorted({str(a.get("libelle") or "").strip() for r in local("gaspar/risques") for c in r.get("communes") or [] if str(c.get("codeInsee") or "") == code for a in c.get("aleas") or [] if a.get("libelle")})
        fallback = public_by_code.get(code, {})
        if fallback.get('status') == 'online':
            risks = fallback['risks']
            local_data['gaspar/risques'] = {'label': 'Risques recensés · API publique', 'status': 'online', 'updated_at': public['updated_at'], 'total_elements': len(risks), 'content': [{'libelle': label} for label in risks]}
        elif local_data['gaspar/risques'].get('total_elements') is None:
            old_risks = (old_commune.get('datasets') or {}).get('gaspar/risques') or {}
            if old_risks.get('updated_at'):
                local_data['gaspar/risques'] = {**deepcopy(old_risks), 'status': 'stale', 'error': 'Source temporairement indisponible'}
                risks = old_commune.get('gaspar_risks') or []
        monitored.append({"name": name, "code_insee": code, "datasets": local_data,
                          "gaspar_risks": risks, "gaspar_risk_total": len(risks) if local_data['gaspar/risques'].get('total_elements') is not None else None,
                          "seismic_zone": next((str(r.get("zoneSismicite") or r.get("typeZone")) for r in local_data["zonage_sismique"].get("content", [])), "inconnue"),
                          "radon_class": str(radon[0].get("classePotentiel")) if radon else None,
                          "radon_potential": str(radon[0].get("classePotentiel")) if radon else None,
                          "dicrim_publication_year": max((str(r.get('anneePublication')) for r in local('gaspar/dicrim') if r.get('anneePublication')), default=None),
                          "flood_documents_details": [{"code": r.get('idGaspar'), "title": r.get('libelle'), "river_basin": r.get('libBassinRisques')} for r in local('gaspar/azi')],
                          "ground_movements_total": local_data["mvt"]["total_elements"], "landslides_total": local_data["mvt"]["total_elements"], "cavities_total": local_data["cavites"]["total_elements"]})
    ppr = [count("gaspar/" + key) for key in ("pprn", "pprm", "pprt")]
    seismic_codes = []
    for commune in monitored:
        value = str(commune['seismic_zone'])
        if value.isdigit() and 1 <= int(value) <= 5:
            seismic_codes.append(int(value))
    highest = max(seismic_codes, default=0)
    return {"service": "Géorisques", "status": "degraded" if errors else "online", "source": "https://www.georisques.gouv.fr/doc-api",
            "api_mode": "v2-token" if token else "v2-token-required", "scope": "Communes PCS suivies en Isère", "scope_codes": sorted(codes),
            "datasets": datasets, "monitored_communes": monitored, "updated_at": now, "errors": errors, "error": errors[0] if errors else None,
            "api_errors": api_errors, "recovered_sources": recovered,
            "highest_seismic_zone_code": highest or None, "highest_seismic_zone_label": f"Zone {highest}" if highest else "inconnue",
            "ground_movements_total": count("mvt"), "cavities_total": count("cavites"), "flood_documents_total": count("gaspar/azi"),
            "ppr_total": sum(ppr) if all(v is not None for v in ppr) else None,
            "ppr_categories": dict(zip(("pprn", "pprm", "pprt"), ppr)), "dicrim_total": count("gaspar/dicrim"), "tim_total": count("gaspar/tim")}
