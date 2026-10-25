/* Official commune report form: retain identity and omit unknown coordinates. */
(() => {
  'use strict';
  const root = 'https://www.georisques.gouv.fr/mes-risques/connaitre-les-risques-pres-de-chez-moi';
  function report(commune = {}) {
    commune = commune && typeof commune === 'object' ? commune : {};
    const code = String(commune.code_insee || commune.insee_code || commune.insee || '').trim();
    const name = String(commune.official_name || commune.name || commune.communeName || '').trim();
    if (!/^\d[\dAB]\d{3}$/.test(code) || !name) return root;
    const postal = String(commune.postal_code || commune.postalCode || '').trim();
    const query = new URLSearchParams({'form-commune':'true', codeInsee:code, city:name, typeForm:'commune', type:'municipality', propertiesType:'', go_back:'/accueil-collectivite', commune: postal ? `${postal}, ${name}` : name});
    if (/^\d{5}$/.test(postal)) query.set('postCode', postal);
    const lat = commune.latitude, lon = commune.longitude;
    if (lat !== null && lat !== undefined && lat !== '' && lon !== null && lon !== undefined && lon !== '' && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180) {
      query.set('lat', String(Number(lat))); query.set('lon', String(Number(lon)));
    }
    const destination = /^\d{5}$/.test(postal) ? `${root}/rapport2/${encodeURIComponent(code)}/${encodeURIComponent(name)}/commune/${encodeURIComponent(postal)}` : `${root}/rapport2`;
    return `${destination}?${query.toString()}`;
  }
  function detail(commune, code) {
    if (!/^[A-Z0-9_]{2,30}$/.test(String(code))) return report(commune);
    const query = new URLSearchParams(report(commune).split('?')[1] || '');
    if (!query.get('codeInsee')) return report(commune);
    query.set('type', 'commune');
    if (query.get('lat')) query.set('latitude', query.get('lat'));
    if (query.get('lon')) query.set('longitude', query.get('lon'));
    return `${root}/detail/${encodeURIComponent(code)}?${query.toString()}`;
  }
  window.GeorisquesLinks = { report, detail };
})();
