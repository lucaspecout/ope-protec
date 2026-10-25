"""Regression checks on real sessions, HTTP cookies, uploads and readiness."""
import ast
import asyncio
from datetime import datetime
import io
import json
from pathlib import Path
import ssl
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI, HTTPException, Request, Response, Depends
from fastapi.testclient import TestClient
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from jose import jwt
from PIL import Image
from app import session_security as security
from app.database import Base
from app.models import User, AppSetting
from app.schemas import LoginResponse
from app.upload_security import read_document, store_document
from app.health_status import readiness
from app.login_throttle import LoginThrottle
from test_bootstrap_performance import load_functions


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread':False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='operator', hashed_password='existing-password-hash', role='ope', auth_source='local')
        self.db.add(self.user); self.db.commit()
        self.settings = SimpleNamespace(secret_key='test-only-key-'*4, access_token_expire_minutes=60, cors_origins='', session_cookie_secure=None)
        self.patcher = patch.object(security, 'settings', self.settings)
        self.patcher.start()
        self.app = FastAPI()
        def database():yield self.db
        def bearer(request: Request):
            return request.headers.get('authorization', '').removeprefix('Bearer ') or None
        # Load the actual migration/logout endpoints, without importing startup collectors.
        env={'Request':Request,'Response':Response,'Session':Session,'Depends':Depends,
             'oauth2_scheme':bearer,'get_db':database,'session_security':security}
        load_functions(['migrate_browser_session','logout_session'], env)
        # The AST loader removes defaults; restore real FastAPI dependencies.
        for name in ('migrate_browser_session','logout_session'):
            env[name].__defaults__ = (Depends(bearer), Depends(database))
        self.app.post('/auth/session')(env['migrate_browser_session'])
        self.app.post('/auth/logout')(env['logout_session'])
        env.update({'__package__':'app','asyncio':asyncio,'datetime':datetime,
                    'User':User,'_redis':None,'_get_client_ip':lambda request:'unit-test',
                    'verify_and_upgrade':lambda password,hashed:(password=='test-password',None),
                    'SessionLocal':Mock(return_value=Mock()),'AuditLog':Mock(),'prune_audit_logs':lambda db:None,
                    'SQLAlchemyError':SQLAlchemyError,'HTTPException':HTTPException})
        load_functions(['login'],env)
        env['login'].__defaults__=(Depends(OAuth2PasswordRequestForm),Depends(database))
        self.app.post('/auth/login',response_model=LoginResponse)(env['login'])
        self.throttle_patch=patch('app.login_throttle.login_throttle',LoginThrottle())
        self.throttle_patch.start()
        @self.app.api_route('/protected', methods=['GET','POST'])
        def protected(request: Request):
            user=security.authenticate(self.db, security.request_token(request,bearer(request)))
            return {'username':user.username}
        self.client=TestClient(self.app,base_url='https://testserver')

    def tearDown(self):
        self.client.close();self.db.close();self.engine.dispose();self.patcher.stop();self.throttle_patch.stop()

    def token(self):return security.create_session(self.db,self.user)

    def browser(self):
        token=self.token()
        response=self.client.post('/auth/session', headers={'Authorization':'Bearer '+token,'Origin':'https://testserver'})
        self.assertEqual(response.status_code,200,response.text)
        return response

    def test_secure_cookie_and_no_token_in_migration_body(self):
        response=self.browser()
        cookies=response.headers.get_list('set-cookie')
        self.assertTrue(any('HttpOnly' in v and 'Secure' in v and 'SameSite=lax' in v and v.startswith('pc_session=') for v in cookies))
        self.assertEqual(response.json(),{'status':'authenticated'})
        self.assertEqual(self.client.get('/protected').status_code,200)

    def test_actual_browser_login_returns_marker_and_protected_cookie(self):
        response=self.client.post('/auth/login',data={'username':'operator','password':'test-password'},
                                  headers={'X-Session-Mode':'cookie','Origin':'https://testserver'})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['access_token'],'cookie-session')
        self.assertNotIn('hashed_password',response.text)
        self.assertEqual(self.client.get('/protected').status_code,200)

    def test_actual_api_login_returns_revocable_bearer(self):
        response=self.client.post('/auth/login',data={'username':'operator','password':'test-password'})
        self.assertEqual(response.status_code,200,response.text)
        token=response.json()['access_token']
        self.assertNotEqual(token,'cookie-session')
        self.assertEqual(security.authenticate(self.db,token).id,self.user.id)
        self.assertFalse(self.client.cookies.get(security.COOKIE))

    def test_wrong_password_and_cross_origin_login_fail(self):
        response=self.client.post('/auth/login',data={'username':'operator','password':'wrong'})
        self.assertEqual(response.status_code,401)
        response=self.client.post('/auth/login',data={'username':'operator','password':'test-password'},headers={'Origin':'https://attacker.invalid'})
        self.assertEqual(response.status_code,403)

    def test_cookie_mutations_require_csrf_and_valid_origin(self):
        self.browser()
        self.assertEqual(self.client.post('/protected').status_code,403)
        csrf=self.client.cookies.get(security.CSRF_COOKIE)
        headers={'X-CSRF-Token':csrf,'Origin':'https://testserver'}
        self.assertEqual(self.client.post('/protected',headers=headers).status_code,200)
        headers['Origin']='https://attacker.invalid'
        self.assertEqual(self.client.post('/protected',headers=headers).status_code,403)
        self.assertEqual(self.client.post('/auth/logout',headers=headers).status_code,403)

    def test_logout_revokes_copied_token_and_deletes_cookies(self):
        self.browser()
        copied=self.client.cookies.get(security.COOKIE)
        csrf=self.client.cookies.get(security.CSRF_COOKIE)
        response=self.client.post('/auth/logout',headers={'X-CSRF-Token':csrf})
        self.assertEqual(response.status_code,200)
        self.assertFalse(self.client.cookies.get(security.COOKIE))
        self.assertEqual(self.client.get('/protected',headers={'Authorization':'Bearer '+copied}).status_code,401)

    def test_password_change_invalidates_all_previous_sessions(self):
        first,second=self.token(),self.token()
        self.user.hashed_password='new-password-hash';self.db.commit()
        for token in (first,second):
            with self.assertRaises(HTTPException):security.authenticate(self.db,token)
        self.assertEqual(security.authenticate(self.db,self.token()).id,self.user.id)

    def test_api_bearer_still_works_without_csrf(self):
        token=self.token()
        self.assertEqual(self.client.post('/protected',headers={'Authorization':'Bearer '+token}).status_code,200)

    def test_url_token_is_not_accepted(self):
        self.assertEqual(self.client.get('/protected?token='+self.token()).status_code,401)

    def test_legacy_migration_is_limited_and_not_general_authentication(self):
        import time
        token=jwt.encode({'sub':self.user.username,'exp':int(time.time())+3600},self.settings.secret_key,algorithm='HS256')
        with self.assertRaises(HTTPException):security.authenticate(self.db,token)
        self.assertEqual(security.authenticate(self.db,token,allow_legacy=True).id,self.user.id)
        row=self.db.get(AppSetting,'auth:legacy-migration-until');row.value='1';self.db.commit()
        with self.assertRaises(HTTPException):security.authenticate(self.db,token,allow_legacy=True)

    def test_missing_expiry_or_missing_session_is_rejected(self):
        token=jwt.encode({'sub':self.user.username},self.settings.secret_key,algorithm='HS256')
        with self.assertRaises(HTTPException):security.authenticate(self.db,token,allow_legacy=True)
        token=self.token();self.db.query(AppSetting).delete();self.db.commit()
        with self.assertRaises(HTTPException):security.authenticate(self.db,token)

    def test_expired_session_is_rejected(self):
        claims=jwt.decode(self.token(),self.settings.secret_key,algorithms=['HS256'])
        claims['exp']=1
        token=jwt.encode(claims,self.settings.secret_key,algorithm='HS256')
        with self.assertRaises(HTTPException):security.authenticate(self.db,token)

    def test_insecure_default_key_prevents_startup(self):
        security.validate_configuration()
        self.settings.secret_key='change-me-in-production'
        with self.assertRaises(RuntimeError):security.validate_configuration()


class DocumentTests(unittest.TestCase):
    def rejected(self,raw,name,limit,status):
        with self.assertRaises(HTTPException) as caught:read_document(io.BytesIO(raw),name,limit)
        self.assertEqual(caught.exception.status_code,status)

    def test_bounded_read_and_invalid_content(self):
        self.rejected(b'x'*101,'file.pdf',100,413)
        self.rejected(b'','file.pdf',100,400)
        self.rejected(b'<script>bad()</script>','file.pdf',100,400)
        self.rejected(b'%PDF-1.4\ntruncated','file.pdf',100,400)
        self.rejected(b'fake-image','file.png',100,400)
        self.rejected(b'x','file.html',100,400)

    def test_valid_pdf_and_image_and_unique_storage(self):
        raw=b'%PDF-1.4\nexample\n%%EOF'
        self.assertEqual(read_document(io.BytesIO(raw),'file.pdf',100),raw)
        image=io.BytesIO();Image.new('RGB',(2,2)).save(image,format='PNG')
        self.assertEqual(read_document(io.BytesIO(image.getvalue()),'file.png',1000),image.getvalue())
        self.rejected(image.getvalue(),'file.jpg',1000,400)
        with tempfile.TemporaryDirectory() as directory:
            first=store_document(directory,'same.pdf',raw);second=store_document(directory,'same.pdf',raw)
            self.assertNotEqual(first,second);self.assertEqual(first.read_bytes(),raw)

    def test_failed_database_commit_removes_the_uploaded_file(self):
        import re
        with tempfile.TemporaryDirectory() as directory:
            env={'__package__':'app','Path':Path,'re':re,
                 'settings':SimpleNamespace(upload_dir=directory,max_upload_bytes=1000),
                 'ensure_municipality_scope':Mock(),'sanitize_upload_filename':lambda name:name,
                 'ensure_allowed_extension':lambda name:None,'MunicipalityDocument':lambda **values:SimpleNamespace(**values)}
            load_functions(['upload_municipality_file'],env)
            db=Mock();db.commit.side_effect=OSError('database offline')
            file=SimpleNamespace(filename='test.pdf',file=io.BytesIO(b'%PDF-1.4\nexample\n%%EOF'))
            with self.assertRaises(OSError):
                env['upload_municipality_file'](38,file,'Document','annexe',db,SimpleNamespace(id=1))
            db.rollback.assert_called_once()
            self.assertEqual(list(Path(directory).rglob('*.pdf')),[])


class AvailabilityTests(unittest.TestCase):
    def test_database_failure_and_cache_degradation(self):
        with patch('app.health_status.database_status',return_value='unavailable'):
            payload,status=readiness('unused',Mock(ping=Mock(return_value=True)))
            self.assertEqual(status,503);self.assertEqual(payload['status'],'unavailable')
        with patch('app.health_status.database_status',return_value='ok'):
            payload,status=readiness('unused',Mock(ping=Mock(side_effect=OSError('private error'))))
            self.assertEqual(status,200);self.assertEqual(payload['status'],'degraded')
            self.assertNotIn('private error',json.dumps(payload))
            self.assertEqual(readiness('unused',Mock(ping=Mock(return_value=True)))[0]['status'],'ok')

    def test_login_throttle_local_and_redis_failure(self):
        throttle=LoginThrottle()
        broken=Mock(eval=Mock(side_effect=OSError()))
        for _ in range(10):throttle.check('local','operator',broken)
        with self.assertRaises(HTTPException) as caught:throttle.check('local','operator',broken)
        self.assertEqual(caught.exception.status_code,429)
        throttle.check('another-ip','operator',broken)
        self.assertEqual(broken.eval.call_count,1)

    def test_tls_adapter_requires_certificates_and_hostnames(self):
        source=ast.parse((Path(__file__).resolve().parents[1]/'app/services.py').read_text(encoding='utf-8-sig'))
        node=next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='_make_legacy_ssl_context')
        env={'ssl':ssl};exec(compile(ast.Module(body=[node],type_ignores=[]),'services.py','exec'),env)
        ctx=env['_make_legacy_ssl_context']()
        self.assertTrue(ctx.check_hostname);self.assertEqual(ctx.verify_mode,ssl.CERT_REQUIRED)
        for call in ast.walk(source):
            if isinstance(call,ast.Call):
                for argument in call.keywords:
                    self.assertFalse(argument.arg=='verify' and isinstance(argument.value,ast.Constant) and argument.value.value is False,
                                     f'Certificate verification disabled at line {call.lineno}')

    def test_unknown_risk_never_becomes_green(self):
        env={};load_functions(['compute_global_risk','_risk_rank','_max_level','_safe_int','_safe_float','_risk_level_from_score','compute_global_risk_details'],env)
        self.assertEqual(env['compute_global_risk']('inconnu',None),'gris')
        self.assertEqual(env['compute_global_risk_details']()['level'],'gris')
        self.assertIsNone(env['compute_global_risk_details']()['score'])
        result=env['compute_global_risk_details'](meteo_level='vert',crues_level='vert')
        self.assertEqual(result['level'],'vert');self.assertEqual(result['label'],'0/100')
        self.assertEqual(env['compute_global_risk_details'](meteo_level='rouge')['level'],'rouge')

    def test_private_environment_migration_preserves_database_and_api_access(self):
        import importlib.util
        script=Path(__file__).resolve().parents[2]/'scripts/prepare_security_env.py'
        spec=importlib.util.spec_from_file_location('prepare_security_env',script)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'docker-compose.yml').write_text('''environment:
  POSTGRES_PASSWORD: "dummy-existing-password"
  DATABASE_URL: "postgresql://dummy-existing-url"
  SECRET_KEY: "weak-test-key"
  FIRMS_MAP_KEY: "dummy-existing-firms"
  GEORISQUES_API_TOKEN: ${GEORISQUES_API_TOKEN:-dummy-existing-georisques}
  RTE_ECOWATT_B64: dummy-existing-rte
''',encoding='utf-8')
            module.migrate(root)
            private=(root/'.env').read_text()
            for expected in ('dummy-existing-password','dummy-existing-url','dummy-existing-firms','dummy-existing-georisques','dummy-existing-rte'):
                self.assertIn(expected,private)
                self.assertNotIn(expected,(root/'docker-compose.yml').read_text())
            self.assertNotIn('weak-test-key',private)
            module.migrate(root)
            self.assertEqual((root/'.env').read_text(),private)
            exported=module.export_stack_env(root)
            values=dict(line.split('=',1) for line in exported.read_text().splitlines())
            self.assertEqual(values['POSTGRES_PASSWORD'],'dummy-existing-password')
            self.assertEqual(values['GEORISQUES_API_TOKEN'],'dummy-existing-georisques')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            (root/'docker-compose.yml').write_text('environment:\n  POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}\n',encoding='utf-8')
            with self.assertRaises(RuntimeError):module.migrate(root)
            self.assertFalse((root/'.env').exists())
            module.migrate(root,new_install=True)
            exported=module.export_stack_env(root)
            values=dict(line.split('=',1) for line in exported.read_text().splitlines())
            self.assertEqual(values['DATABASE_URL'],f"postgresql://postgres:{values['POSTGRES_PASSWORD']}@db:5432/veille")
            self.assertNotIn('${',exported.read_text())

    def test_empty_compose_cookie_setting_keeps_automatic_mode(self):
        from app.config import Settings
        self.assertIsNone(Settings(_env_file=None,session_cookie_secure='').session_cookie_secure)


if __name__=='__main__':unittest.main()
