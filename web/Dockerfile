FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend/app /app/backend/app
COPY web /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY web/start.sh /start.sh

RUN chmod +x /start.sh \
    && rm -f /etc/nginx/sites-enabled/default

EXPOSE 80

CMD ["/start.sh"]
