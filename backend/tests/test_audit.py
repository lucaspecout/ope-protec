"""Exercise actual audit middleware and endpoints with revocable sessions and SQLite."""
import ast
import asyncio
from datetime import datetime, timedelta
import json
import logging
from pathlib import Path
import sys
import tempfile
from time import monotonic, sleep
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI, Request, Response, Depends, Query, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, or_, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.exc import SQLAlchemyError
from app import audit, session_security
from app.database import Base
from app.models import User, AuditLog
from app.login_throttle import LoginThrottle


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.engine = create_engine('sqlite:///' + str(Path(self.directory.name) / 'audit.db'), connect_args={'check_same_thread': False})
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(self.engine, expire_on_commit=False)
        self.settings = SimpleNamespace(secret_key='audit-test-key-'*4, access_token_expire_minutes=60, cors_origins='', session_cookie_secure=False)
        self.patcher = patch.object(session_security, 'settings', self.settings)
        self.patcher.start()
        self.throttle = patch('app.login_throttle.login_throttle', LoginThrottle())
        self.throttle.start()
        with self.sessions() as db:
            user = User(username='operator', hashed_password='hash', role='ope', municipality_name='Grenoble', auth_source='local')
            db.add(user); db.commit()
            self.token = session_security.create_session(db, user)
        def database():
            with self.sessions() as db:
                yield db
        def bearer(request: Request):
            return request.headers.get('authorization', '').removeprefix('Bearer ') or None
        def authorize(*roles):
            def dependency(request: Request, db=Depends(database)):
                user = session_security.authenticate(db, session_security.request_token(request, bearer(request)))
                if user.role not in roles:
                    raise HTTPException(403)
                request.state.audit_actor = audit.actor_snapshot(user)
                return user
            return dependency
        self.app = FastAPI()
        env = dict(globals(), __package__='app', app=self.app, get_db=database, oauth2_scheme=bearer,
                   require_roles=authorize, SessionLocal=self.sessions, AUDIT_LOG_MAX_ROWS=500,
                   logger=logging.getLogger('audit-test'), _redis=None,
                   verify_and_upgrade=lambda password, hashed: (password == 'correct-password', None))
        names = {'audit_log_middleware', '_get_request_username', '_get_client_ip', '_path_resource_type',
                 'prune_audit_logs', 'audit_visible_query', 'get_audit_log', 'export_audit_csv', 'login', 'logout_session'}
        tree = ast.parse((Path(__file__).resolve().parents[1] / 'app/main.py').read_text(encoding='utf-8-sig'))
        nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
        for node in nodes:
            node.decorator_list = []
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'audit-routes', 'exec'), env)
        self.app.middleware('http')(env['audit_log_middleware'])
        self.app.post('/auth/login')(env['login'])
        self.app.post('/auth/logout')(env['logout_session'])
        self.app.get('/api/audit')(env['get_audit_log'])
        self.app.get('/api/audit/export/csv')(env['export_audit_csv'])
        @self.app.patch('/events/{event_id}')
        def change(event_id: int, payload: dict, request: Request, user=Depends(authorize('ope', 'admin'))):
            return {'id': event_id}
        self.client = TestClient(self.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.patcher.stop(); self.throttle.stop(); self.engine.dispose(); self.directory.cleanup()

    def rows(self, expected=1):
        deadline = monotonic() + 3
        while monotonic() < deadline:
            with self.sessions() as db:
                rows = db.query(AuditLog).order_by(AuditLog.id).all()
            if len(rows) >= expected:
                return rows
            sleep(.01)
        self.fail(f'Expected {expected} audit rows, got {len(rows)}')

    def admin(self):
        with self.sessions() as db:
            user = db.query(User).first(); user.role = 'admin'; db.commit()

    def test_login_is_one_verified_event_without_password(self):
        response = self.client.post('/auth/login', data={'username': 'operator', 'password': 'correct-password'}, headers={'X-Session-Mode': 'cookie'})
        self.assertEqual(response.status_code, 200, response.text)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].username, 'operator')
        detail = json.loads(rows[0].details)
        self.assertTrue(detail['actor']['identity_verified'])
        self.assertNotIn('correct-password', rows[0].details)
        self.assertEqual(self.client.post('/auth/logout', headers={'X-CSRF-Token': self.client.cookies.get('pc_csrf')}).status_code, 200)
        self.assertEqual(self.rows(2)[1].username, 'operator')

    def test_failed_login_keeps_claimed_name_and_reason_once(self):
        self.assertEqual(self.client.post('/auth/login', data={'username': 'operator', 'password': 'wrong'}).status_code, 401)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].username, 'operator')
        self.assertFalse(json.loads(rows[0].details)['actor'])
        self.assertTrue(json.loads(rows[0].details)['reason'])

    def test_scanner_requests_never_enter_audit(self):
        for _ in range(5):
            self.assertEqual(self.client.post('/api/graphql').status_code, 404)
        self.client.post('/auth/login', data={'username': 'operator', 'password': 'wrong'})
        self.assertEqual(len(self.rows()), 1)

    def test_mutation_captures_target_context_and_historical_actor(self):
        response = self.client.patch('/events/42', json={'title': 'Crue', 'password': 'never-store', 'api_key': 'secret', 'description': 'private-report'}, headers={'Authorization': 'Bearer '+self.token})
        self.assertEqual(response.status_code, 200, response.text)
        row = self.rows()[0]
        self.assertNotIn('never-store', row.details)
        self.assertNotIn('private-report', row.details)
        self.assertNotIn('secret', row.details)
        self.admin()
        item = self.client.get('/api/audit', headers={'Authorization': 'Bearer '+self.token}).json()['items'][0]
        self.assertEqual(item['user_role'], 'ope')
        self.assertEqual(item['user_municipality'], 'Grenoble')
        self.assertEqual(item['target'], {'event_id': '42'})
        self.assertEqual(item['context'], {'title': 'Crue'})
        self.assertIsInstance(item['duration_ms'], (float, int))

    def test_revoked_token_does_not_claim_verified_identity(self):
        with self.sessions() as db:
            session_security.revoke(db, self.token)
        response = self.client.patch('/events/42', json={'title':'Denied'}, headers={'Authorization':'Bearer '+self.token})
        self.assertEqual(response.status_code, 401)
        row = self.rows()[0]
        self.assertEqual(row.username, 'anonymous')
        self.assertFalse(json.loads(row.details)['actor'])

    def test_default_history_and_export_hide_noise_and_keep_auth_failures(self):
        self.admin()
        with self.sessions() as db:
            db.add_all([AuditLog(username='anonymous', action='POST /api/graphql', status_code=404),
                        AuditLog(username='operator', action='POST /auth/login', resource_type='auth', status_code=401),
                        AuditLog(username='operator', action='PATCH /events/1', status_code=302),
                        AuditLog(username='operator', action='PATCH /events/2', status_code=200)])
            db.commit()
        headers = {'Authorization': 'Bearer '+self.token}
        data = self.client.get('/api/audit', headers=headers).json()
        self.assertEqual(data['total'], 3)
        self.assertNotIn('anonymous', data['users'])
        self.assertEqual(self.client.get('/api/audit?include_noise=true', headers=headers).json()['total'], 4)
        self.assertEqual(self.client.get('/api/audit?status=success', headers=headers).json()['total'], 1)
        csv = self.client.get('/api/audit/export/csv', headers=headers).text
        self.assertNotIn('/api/graphql', csv)
        self.assertIn('/auth/login', csv)
        self.assertIn('action_label,outcome', csv)

    def test_audit_is_admin_only(self):
        self.assertEqual(self.client.get('/api/audit', headers={'Authorization':'Bearer '+self.token}).status_code, 403)
        self.assertEqual(self.client.get('/api/audit/export/csv', headers={'Authorization':'Bearer '+self.token}).status_code, 403)
        self.assertEqual(self.client.get('/api/audit').status_code, 401)

    def test_module_classification_and_safe_context(self):
        self.assertEqual(audit.resource_type('/auth/users/2'), 'users')
        self.assertEqual(audit.resource_type('/api/admin/integrations/credentials'), 'interconnections')
        self.assertEqual(audit.resource_type('/api/notifications/1'), 'notifications')
        self.assertEqual(audit.safe_context({'password':'x','token':'y','title':'Crue','role':'ope'}), {'title':'Crue','role':'ope'})


if __name__ == '__main__':
    unittest.main()
