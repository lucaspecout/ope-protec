const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = vm.createContext({window:{}, URLSearchParams});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/georisques_links.js'),'utf8'),context);
const report = context.window.GeorisquesLinks.report;
test('commune report carries the actual official form parameters and accented identity',()=>{
  const u = new URL(report({code_insee:'38310',official_name:'Poliénas',postal_code:'38210',latitude:45.25,longitude:5.47}));
  assert.equal(u.hostname,'www.georisques.gouv.fr');
  assert.equal(u.searchParams.get('form-commune'),'true');
  assert.equal(u.searchParams.get('typeForm'),'commune');
  assert.equal(u.searchParams.get('type'),'municipality');
  assert.equal(u.searchParams.get('codeInsee'),'38310');
  assert.equal(u.searchParams.get('city'),'Poliénas');
  assert.equal(u.searchParams.get('postCode'),'38210');
  assert.equal(u.searchParams.get('commune'),'38210, Poliénas');
  assert.equal(u.searchParams.get('lat'),'45.25');
  assert.equal(u.searchParams.get('lon'),'5.47');
  assert.equal(u.searchParams.has('form-adresse'),false);
  assert.equal(u.pathname,'/mes-risques/connaitre-les-risques-pres-de-chez-moi/rapport2/38310/Poli%C3%A9nas/commune/38210');
});
test('risk detail links use the official category code and commune scope',()=>{
  const u=new URL(context.window.GeorisquesLinks.detail({code_insee:'38179',name:'Gières',postal_code:'38610'},'SEC'));
  assert.equal(u.pathname,'/mes-risques/connaitre-les-risques-pres-de-chez-moi/detail/SEC');
  assert.equal(u.searchParams.get('codeInsee'),'38179');
  assert.equal(u.searchParams.get('typeForm'),'commune');
  assert.equal(u.searchParams.get('type'),'commune');
  assert.equal(new URL(context.window.GeorisquesLinks.detail({name:'Gières'},'../other')).hostname,'www.georisques.gouv.fr');
});
test('unknown coordinates never turn into a zero coordinate pair',()=>{
  for(const value of [null,undefined,'','invalid']){
    const u=new URL(report({code_insee:'38179',name:'Gières',latitude:value,longitude:value}));
    assert.equal(u.searchParams.has('lat'),false);
    assert.equal(u.searchParams.has('lon'),false);
  }
});
test('invalid identity returns the official selector, never a malformed report',()=>{
  for(const row of [null,undefined,{name:'Gières'},{code_insee:'38179'}, {name:'Gières',code_insee:'38179&city=Other'}]){
    assert.equal(new URL(report(row)).pathname.endsWith('/rapport2'),false);
  }
});
test('changing commune changes every identity parameter',()=>{
  const first=new URL(report({name:'Gières',code_insee:'38179',postal_code:'38610',latitude:45.17,longitude:5.8}));
  const next=new URL(report({name:'Beaurepaire',code_insee:'38034',postal_code:'38270'}));
  assert.notEqual(first.searchParams.get('city'),next.searchParams.get('city'));
  assert.equal(next.searchParams.get('codeInsee'),'38034');
  assert.equal(next.searchParams.get('postCode'),'38270');
  assert.equal(next.searchParams.has('lat'),false);
});
