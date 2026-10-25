"""Short login attempt limits, shared through Redis with a bounded local fallback."""
import hashlib
from threading import Lock
from time import monotonic, time
from fastapi import HTTPException

class LoginThrottle:
    window = 300

    def __init__(self):
        self.entries = {}
        self.lock = Lock()
        self.redis_retry_at = 0

    def check(self, ip, username, redis=None):
        keys = ((f'ip:{ip}', 60), (f'account:{ip}:{username.strip().casefold()}', 10))
        for identity, limit in keys:
            key = 'auth:attempts:' + hashlib.sha256(identity.encode()).hexdigest()
            count = None
            if redis is not None and monotonic() >= self.redis_retry_at:
                try:
                    # Fixed buckets expire atomically even if a worker terminates.
                    bucket = key + ':' + str(int(time()) // self.window)
                    count = redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n", 1, bucket, self.window + 1)
                except Exception:
                    self.redis_retry_at = monotonic() + 30
            if count is None:
                with self.lock:
                    now = monotonic()
                    if len(self.entries) >= 10000:
                        self.entries = {k:v for k,v in self.entries.items() if v[1] > now}
                        if len(self.entries) >= 10000:
                            raise HTTPException(429, 'Trop de connexions. Réessayez dans cinq minutes.', headers={'Retry-After':'300'})
                    attempts, expiry = self.entries.get(key, (0, now + self.window))
                    if expiry <= now:attempts, expiry = 0, now + self.window
                    count = attempts + 1
                    self.entries[key] = (count, expiry)
            if int(count) > limit:
                raise HTTPException(429, 'Trop de tentatives. Réessayez dans cinq minutes.', headers={'Retry-After':'300'})

login_throttle = LoginThrottle()
