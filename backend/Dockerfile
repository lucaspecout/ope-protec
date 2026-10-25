FROM python:3.12.15-slim

# Certificate verification remains enabled, including the scoped TLS 1.2 adapter.

WORKDIR /app
COPY requirements.txt requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY app ./app
COPY gunicorn.conf.py .
EXPOSE 8000
CMD ["gunicorn", "-c", "gunicorn.conf.py", "app.main:app"]
