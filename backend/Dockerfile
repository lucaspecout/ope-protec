FROM python:3.12-slim

# Configuration OpenSSL permissive pour les serveurs gouvernementaux avec TLS legacy
# (opendata.isere.fr et autres retournent TLSV1_ALERT_INTERNAL_ERROR avec OpenSSL 3.0+ strict)
COPY openssl-legacy.cnf /etc/ssl/legacy-openssl.cnf
ENV OPENSSL_CONF=/etc/ssl/legacy-openssl.cnf

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY gunicorn.conf.py .
EXPOSE 8000
CMD ["gunicorn", "-c", "gunicorn.conf.py", "app.main:app"]
