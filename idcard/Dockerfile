# Card API for Google Cloud Run (or any Docker host). Build from the idcard/ folder.
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-liberation && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY idcard.py layout.json template_base.png logo_hd.png ./
COPY fonts ./fonts
COPY server ./server
ENV PORT=8080
CMD exec gunicorn -b 0.0.0.0:$PORT -w 2 --timeout 120 server.app:app
