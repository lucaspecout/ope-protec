"""Revocable browser sessions; bearer clients remain supported without URL tokens."""
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import secrets
from urllib.parse import urlsplit

from fastapi import HTTPException
from jose import jwt, JWTError
from .config import settings
from .models import AppSetting, User

COOKIE = 'pc_session'
CSRF_COOKIE = 'pc_csrf'
PREFIX = 'auth:session:'

def validate_configuration():
    if settings.secret_key in ('', 'change-me-in-production') or len(settings.secret_key) < 32:
        raise RuntimeError('SECRET_KEY doit être une clé privée de 32 caractères minimum. Exécuter scripts/prepare_security_env.py.')

def version(user):
    return hashlib.sha256(f'{user.id}:{user.auth_source}:{user.hashed_password}'.encode()).hexdigest()

def create_session(db, user):
    now = datetime.now(timezone.utc)
    expiry = now + timedelta(minutes=settings.access_token_expire_minutes)
    identifier = secrets.token_urlsafe(32)
    payload = {'sub':user.username, 'jti':identifier, 'sv':version(user), 'iat':int(now.timestamp()), 'exp':int(expiry.timestamp())}
    db.add(AppSetting(key=PREFIX+identifier, value=json.dumps({'username':user.username, 'expires':expiry.timestamp()})))
    # Remove expired session rows without affecting other settings or active sessions.
    for row in db.query(AppSetting).filter(AppSetting.key.like(PREFIX+'%')).limit(1000).all():
        try:
            if json.loads(row.value).get('expires',0) < now.timestamp():db.delete(row)
        except (ValueError,TypeError):
            db.delete(row)
    db.commit()
    return jwt.encode(payload, settings.secret_key, algorithm='HS256')

def authenticate(db, token, allow_legacy=False):
    try:
        claims = jwt.decode(token, settings.secret_key, algorithms=['HS256'])
        username = claims.get('sub')
        if not isinstance(username,str) or not username or not claims.get('exp'):raise ValueError()
        user = db.query(User).filter(User.username==username).first()
        if not user:raise ValueError()
        identifier = claims.get('jti')
        if not identifier:
            if not allow_legacy:raise ValueError()
            # Only the migration endpoint accepts old tokens, for one deployment day.
            row = db.get(AppSetting,'auth:legacy-migration-until')
            if row is None:
                row=AppSetting(key='auth:legacy-migration-until',value=str((datetime.now(timezone.utc)+timedelta(hours=24)).timestamp()))
                db.add(row);db.commit()
            if datetime.now(timezone.utc).timestamp()>float(row.value):raise ValueError()
        else:
            if not isinstance(identifier,str) or len(identifier)>80 or not db.get(AppSetting,PREFIX+identifier):raise ValueError()
            if not hmac.compare_digest(str(claims.get('sv') or ''),version(user)):raise ValueError()
        return user
    except (JWTError,ValueError,TypeError,KeyError):
        raise HTTPException(401,'Session expirée ou révoquée') from None

def revoke(db, token):
    try:
        claims=jwt.decode(token,settings.secret_key,algorithms=['HS256'])
        identifier=claims.get('jti')
        if isinstance(identifier,str):
            row=db.get(AppSetting,PREFIX+identifier)
            if row:db.delete(row);db.commit()
    except (JWTError,ValueError,TypeError):pass

def check_origin(request):
    origin=request.headers.get('origin')
    if not origin:return
    parsed=urlsplit(origin)
    allowed={value.strip().rstrip('/') for value in settings.cors_origins.split(',') if value.strip()}
    if parsed.netloc != request.headers.get('host') and origin.rstrip('/') not in allowed:
        raise HTTPException(403,'Origine de la requête refusée')

def request_token(request, bearer=None):
    cookie=request.cookies.get(COOKIE)
    if cookie:
        if request.method not in ('GET','HEAD','OPTIONS'):
            check_origin(request)
            supplied=request.headers.get('x-csrf-token') or ''
            csrf=request.cookies.get(CSRF_COOKIE) or ''
            if not supplied or not csrf or not hmac.compare_digest(supplied,csrf):raise HTTPException(403,'Protection CSRF : rechargez la page')
        return cookie
    if bearer and bearer != 'cookie-session':return bearer
    raise HTTPException(401,'Connexion requise')

def set_cookies(response, request, token):
    secure=settings.session_cookie_secure
    if secure is None:
        secure=request.url.scheme=='https' or (urlsplit(request.headers.get('origin','')).scheme=='https' and urlsplit(request.headers.get('origin','')).netloc==request.headers.get('host'))
    common={'secure':secure,'samesite':'lax','path':'/','max_age':settings.access_token_expire_minutes*60}
    response.set_cookie(COOKIE,token,httponly=True,**common)
    response.set_cookie(CSRF_COOKIE,secrets.token_urlsafe(32),httponly=False,**common)
    response.headers['Cache-Control']='no-store'

def clear_cookies(response):
    response.delete_cookie(COOKIE,path='/')
    response.delete_cookie(CSRF_COOKIE,path='/')
    response.headers['Cache-Control']='no-store'
