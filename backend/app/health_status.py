"""Readiness checks with short, independent DB connections and no secret errors."""
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

def database_status(url):
    engine=None
    try:
        args={'connect_timeout':2} if str(url).startswith('postgresql') else {'timeout':2}
        engine=create_engine(url,poolclass=NullPool,connect_args=args)
        with engine.connect() as connection:
            if connection.dialect.name=='postgresql':connection.execute(text("SET statement_timeout = '2000ms'"))
            connection.execute(text('SELECT 1'))
        return 'ok'
    except Exception:return 'unavailable'
    finally:
        if engine:engine.dispose()

def readiness(url, redis_client=None):
    database=database_status(url)
    try:
        cache='ok' if redis_client is not None and redis_client.ping() else 'unavailable'
    except Exception:cache='unavailable'
    status='unavailable' if database!='ok' else 'ok' if cache=='ok' else 'degraded'
    return {'status':status,'checks':{'database':database,'redis':cache}},503 if database!='ok' else 200
