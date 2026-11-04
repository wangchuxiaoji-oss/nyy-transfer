FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends -y libimage-exiftool-perl libvips42 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-media-worker.txt ./
RUN pip install -r requirements-media-worker.txt

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin media-worker
COPY --chown=media-worker:media-worker app ./app

USER media-worker

CMD ["python", "-m", "app.workers.media_worker"]
