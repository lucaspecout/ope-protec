"""Local Edge regression: real auth endpoints, real browser cookies, fixture business data."""
from pathlib import Path
import sys
from threading import Lock
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend/tests'))
import smoke_official_sources as base
import smoke_vigieau as browser
from test_security_hardening import SessionTests
from app import session_security as security
from fastapi import Request


def main():
    case=SessionTests();case.setUp()
    case.settings.session_cookie_secure=False  # Local HTTP only; HTTPS is tested separately.
    case.user.role='admin';case.db.commit()
    lock=Lock()
    @case.app.get('/auth/me')
    def me(request:Request):
        security.authenticate(case.db,security.request_token(request))
        return base.USER

    class Handler(base.Handler):
        def auth(self):
            with lock:
                case.client.cookies.clear()
                raw=self.rfile.read(int(self.headers.get('Content-Length','0'))) if self.command=='POST' else None
                response=case.client.request(self.command,self.path,headers=dict(self.headers),content=raw)
                self.send_response(response.status_code)
                for name,value in response.headers.multi_items():
                    if name.lower() not in ('content-length','connection','transfer-encoding'):
                        self.send_header(name,value)
                self.send_header('Content-Length',str(len(response.content)))
                self.end_headers();self.wfile.write(response.content)

        def do_GET(self):
            if urlsplit(self.path).path.startswith(('/auth/','/protected')):return self.auth()
            return super().do_GET()

        def do_POST(self):
            if urlsplit(self.path).path.startswith(('/auth/','/protected')):return self.auth()
            return super().do_POST()

    base.INIT='''<script>
localStorage.clear();window.__smokeErrors=[];
window.addEventListener('error',e=>window.__smokeErrors.push(e.message));
window.addEventListener('unhandledrejection',e=>window.__smokeErrors.push(String(e.reason)));
</script>'''
    base.CHECKS='''<script>
(async()=>{
const results=[],check=(name,pass)=>results.push({name,pass:Boolean(pass)});
const pause=()=>new Promise(r=>setTimeout(r,100));
try{
  for(let i=0;i<100&&typeof isLoginSubmitting==='undefined';i++)await pause();
  document.getElementById('login-username').value='operator';
  document.getElementById('login-password').value='test-password';
  document.getElementById('login-form').requestSubmit();
  for(let i=0;i<100&&(typeof token==='undefined'||token!=='cookie-session'||document.getElementById('app-view').hidden);i++)await pause();
  check('actual login opens application',!document.getElementById('app-view').hidden&&token==='cookie-session');
  check('access token absent from localStorage',localStorage.getItem('token')===null);
  check('HttpOnly cookie hidden from JavaScript',!document.cookie.includes('pc_session='));
  check('CSRF cookie available',Boolean(sessionCsrfToken()));
  check('authenticated read with browser cookie',(await fetch('/protected')).status===200);
  check('unprotected mutation rejected',(await fetch('/protected',{method:'POST'})).status===403);
  check('application helper sends CSRF',(await fetchWithTimeout('/protected',{method:'POST'})).status===200);
  await logout();
  check('logout closes application',document.getElementById('app-view').hidden&&token===null);
  check('cookie is removed on logout',!sessionCsrfToken());
  check('protected read rejected after logout',(await fetch('/protected')).status===401);
  check('no runtime errors',window.__smokeErrors.length===0);
}catch(e){results.push({name:'exception',pass:false,error:String(e.stack||e)});}
const pre=document.createElement('pre');pre.id='smoke-results';pre.hidden=true;
pre.textContent=JSON.stringify({results,errors:window.__smokeErrors,metrics:{innerWidth,bodyWidth:document.body.scrollWidth}});
document.body.appendChild(pre);
})();</script>'''
    browser.Handler=Handler
    output=ROOT/'.test-data/security';output.mkdir(parents=True,exist_ok=True)
    try:
        if not browser.run('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',390,output,height=844):
            raise SystemExit(1)
    finally:case.tearDown()


if __name__=='__main__':main()
