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
    return `${root}/rapport2?${query.toString()}`;
  }
  window.GeorisquesLinks = { report };
})();
