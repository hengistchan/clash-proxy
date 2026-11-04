FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    STASH_TEMPLATE_DIR=/app

WORKDIR /app

COPY requirements-service.txt ./
RUN pip install --no-cache-dir -r requirements-service.txt

COPY Production.yaml Production-NoAds.yaml ./
COPY service ./service

RUN addgroup --system --gid 10001 app \
    && adduser --system --uid 10001 --ingroup app --home /app app

USER 10001:10001
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3)"]

CMD ["uvicorn", "service.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
