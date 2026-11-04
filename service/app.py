"""Stateless Stash full-configuration generator."""
from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

import yaml
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = Path(__file__).resolve().parent / 'static'
TEMPLATES = {
    'production': ('Production.yaml', 'hj-stash-production.yaml'),
    'no_ads': ('Production-NoAds.yaml', 'hj-stash-no-ads.yaml'),
}
TEMPLATE_ALIASES = {
    'production': 'production',
    'production.yaml': 'production',
    'no_ads': 'no_ads',
    'no-ads': 'no_ads',
    'production-noads.yaml': 'no_ads',
}


@dataclass(frozen=True)
class Settings:
    template_dir: Path = ROOT
    max_url_length: int = 4096

    @classmethod
    def from_env(cls):
        template_dir = Path(os.getenv('STASH_TEMPLATE_DIR', str(ROOT))).expanduser().resolve()
        try:
            max_url_length = int(os.getenv('STASH_MAX_URL_LENGTH', '4096'))
        except ValueError:
            max_url_length = 4096
        return cls(template_dir=template_dir, max_url_length=max(512, min(max_url_length, 16384)))


class ConfigRequest(BaseModel):
    url: str
    template: str = 'production'


def normalize_template(value):
    key = (value or 'production').strip().lower()
    if key not in TEMPLATE_ALIASES:
        raise HTTPException(status_code=400, detail='Unknown configuration template.')
    return TEMPLATE_ALIASES[key]


def validate_subscription_url(value, max_length):
    if not isinstance(value, str):
        raise HTTPException(status_code=400, detail='A YAML subscription URL is required.')
    url = value.strip()
    if not url or len(url) > max_length:
        raise HTTPException(status_code=400, detail='The subscription URL is missing or too long.')
    if any(char in url for char in ('\n', '\r', '\t', ' ')):
        raise HTTPException(status_code=400, detail='Whitespace is not allowed in the subscription URL.')
    try:
        parsed = urlsplit(url)
        parsed.port
    except ValueError:
        raise HTTPException(status_code=400, detail='The subscription URL is invalid.')
    if parsed.scheme != 'https' or not parsed.hostname:
        raise HTTPException(status_code=400, detail='The subscription URL must use HTTPS.')
    if parsed.username or parsed.password or parsed.fragment:
        raise HTTPException(status_code=400, detail='Credentials and fragments are not allowed.')
    if parsed.hostname.endswith('example.invalid'):
        raise HTTPException(status_code=400, detail='Replace the template placeholder with a real subscription URL.')
    return url


def render_profile(settings, raw_url, raw_template):
    url = validate_subscription_url(raw_url, settings.max_url_length)
    template_key = normalize_template(raw_template)
    template_name, download_name = TEMPLATES[template_key]
    template_path = settings.template_dir / template_name
    if not template_path.is_file():
        raise HTTPException(status_code=503, detail='Configuration template is unavailable.')

    original = template_path.read_text(encoding='utf-8')
    try:
        parsed = yaml.safe_load(original)
        placeholder = parsed['proxy-providers']['GLaDOS']['url']
    except (KeyError, TypeError, yaml.YAMLError):
        raise HTTPException(status_code=503, detail='Configuration template is invalid.')
    if (
        not isinstance(placeholder, str)
        or not placeholder.startswith('https://example.invalid/')
        or original.count(placeholder) != 1
    ):
        raise HTTPException(status_code=503, detail='Configuration template placeholder is invalid.')

    rendered = original.replace(placeholder, url)
    try:
        verified = yaml.safe_load(rendered)
    except yaml.YAMLError:
        raise HTTPException(status_code=503, detail='Rendered configuration is invalid.')
    if verified.get('proxy-providers', {}).get('GLaDOS', {}).get('url') != url:
        raise HTTPException(status_code=503, detail='Rendered configuration verification failed.')

    body = rendered.encode('utf-8')
    digest = hashlib.sha256(body).hexdigest()
    headers = {
        'Content-Disposition': f'attachment; filename="{download_name}"',
        'Cache-Control': 'no-store, max-age=0',
        'Pragma': 'no-cache',
        'Referrer-Policy': 'no-referrer',
        'X-Config-SHA256': digest,
        'X-Content-Type-Options': 'nosniff',
    }
    return Response(content=body, media_type='application/yaml', headers=headers)


def create_app(settings: Optional[Settings] = None):
    active_settings = settings or Settings.from_env()
    app = FastAPI(
        title='Stash Config Forge',
        description='Generate a complete Stash configuration from a private YAML subscription URL.',
        version='1.0.0',
        docs_url=None,
        redoc_url=None,
        openapi_url='/api/openapi.json',
    )

    @app.middleware('http')
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()'
        response.headers['Content-Security-Policy'] = (
            "default-src 'self'; style-src 'self'; script-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
            "frame-ancestors 'none'; form-action 'self'"
        )
        return response

    @app.get('/api/health', include_in_schema=False)
    def health():
        return {'status': 'ok', 'service': 'stash-config-forge'}

    @app.get('/api')
    def generate_get(url: str, template: str = 'production'):
        return render_profile(active_settings, url, template)

    @app.post('/api')
    def generate_post(payload: ConfigRequest):
        return render_profile(active_settings, payload.url, payload.template)

    @app.get('/', include_in_schema=False)
    def index():
        return FileResponse(STATIC_DIR / 'index.html')

    app.mount('/static', StaticFiles(directory=STATIC_DIR), name='static')
    return app
