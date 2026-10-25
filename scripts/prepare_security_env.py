"""Move existing Compose literals into ignored .env without rotating live credentials."""
from pathlib import Path
import os
import re
import secrets

ROOT=Path(__file__).resolve().parents[1]
KEYS=('POSTGRES_PASSWORD','DATABASE_URL','SECRET_KEY','FIRMS_MAP_KEY','GEORISQUES_API_TOKEN','RTE_ECOWATT_B64','RTE_CONSUMPTION_B64')

def migrate(root=ROOT):
    compose=root/'docker-compose.yml';env=root/'.env'
    source=compose.read_text(encoding='utf-8')
    existing=env.read_text(encoding='utf-8') if env.exists() else ''
    present=set(re.findall(r'^([A-Z_]+)=',existing,re.M))
    additions=[];moved=[]
    for key in KEYS:
        pattern=re.compile(r'^(\s*'+key+r':\s*)([^\r\n]+)',re.M)
        match=pattern.search(source)
        if not match:continue
        value=match[2].strip()
        embedded=re.fullmatch(r'\$\{'+key+r':-([^}]+)\}',value)
        if embedded:value=embedded[1]
        if '${' not in value:
            if key not in present:
                if len(value)>1 and value[0] in '\"\'' and value[-1]==value[0]:value=value[1:-1]
                additions.append(key+"='"+value.replace("'","\\'")+"'")
                present.add(key)
            required=key in ('POSTGRES_PASSWORD','DATABASE_URL','SECRET_KEY')
            source=pattern.sub(lambda m:m[1]+'${'+key+(':?Run python scripts/prepare_security_env.py}' if required else ':-}'),source,count=1)
            moved.append(key)
    # Also support a new installation after all literals have been removed.
    if 'POSTGRES_PASSWORD' not in present:
        additions.append('POSTGRES_PASSWORD='+secrets.token_urlsafe(36));present.add('POSTGRES_PASSWORD')
    if 'SECRET_KEY' not in present:
        additions.append('SECRET_KEY='+secrets.token_urlsafe(48));present.add('SECRET_KEY')
    if 'FIRMS_MAP_KEY' not in present:additions.append('FIRMS_MAP_KEY=')
    if 'DATABASE_URL' not in present:
        # Compose substitutes this value from the password on fresh installs.
        additions.append('DATABASE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/veille')
    # Optional API keys must never prevent a fresh installation from starting.
    source=source.replace('${FIRMS_MAP_KEY:?Run python scripts/prepare_security_env.py}', '${FIRMS_MAP_KEY:-}')
    if additions:
        with env.open('a',encoding='utf-8') as stream:
            if existing and not existing.endswith('\n'):stream.write('\n')
            stream.write('\n# Private runtime settings. Never commit this file.\n'+'\n'.join(additions)+'\n')
        os.chmod(env,0o600)
    private=env.read_text(encoding='utf-8')
    signing=re.search(r'^SECRET_KEY=(.*)$',private,re.M)
    if signing and (len(signing[1].strip().strip('\"\'')) < 32 or signing[1].strip().strip('\"\'') == 'change-me-in-production'):
        private=private[:signing.start(1)]+secrets.token_urlsafe(48)+private[signing.end(1):]
        env.write_text(private,encoding='utf-8')
        os.chmod(env,0o600)
        moved.append('SECRET_KEY upgraded (sign in again after deployment)')
    if source!=compose.read_text(encoding='utf-8'):compose.write_text(source,encoding='utf-8')
    return moved

if __name__=='__main__':
    moved=migrate()
    print('Private .env prepared; database and API credentials preserved. Values are never printed.')
    print('Externalized settings: '+', '.join(moved))
