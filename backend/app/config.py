"""Backend configuration read from environment variables (Requirement 2).

`get_settings()` is cached; tests call `get_settings.cache_clear()` after
changing the environment.

`seed_today` (MAATRIVA_SEED_TODAY) is read ONLY by `app.seed`. Every runtime
code path uses `timeutil.utcnow()` (Req 2.4).
"""
from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parent.parent
SECRETS_DIR = BACKEND_DIR / ".secrets"
DEFAULT_DATABASE_URL = f"sqlite:///{(BACKEND_DIR / 'maatriva.db').as_posix()}"


@dataclass(frozen=True)
class Settings:
    database_url: str
    jwt_secret: str
    token_ttl_field_h: int = 168
    token_ttl_staff_h: int = 12
    demo: bool = False
    triage_interval_s: int = 900
    seed_today: Optional[date] = None  # read ONLY by seed.py


def load_jwt_secret(secrets_dir: Path = SECRETS_DIR) -> str:
    """Return MAATRIVA_JWT_SECRET, else the stored dev secret, else create one."""
    env = os.environ.get("MAATRIVA_JWT_SECRET")
    if env:
        return env
    path = secrets_dir / "jwt_secret"
    if path.exists():
        value = path.read_text(encoding="utf-8").strip()
        if value:
            return value
    secrets_dir.mkdir(parents=True, exist_ok=True)
    value = secrets.token_hex(32)
    path.write_text(value, encoding="utf-8")
    log.warning("using generated dev JWT secret at %s", path)
    return value


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw.strip())
    except ValueError:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from None


def _env_date(name: str) -> Optional[date]:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return None
    try:
        return date.fromisoformat(raw.strip())
    except ValueError:
        raise ValueError(f"{name} must be YYYY-MM-DD, got {raw!r}") from None


@lru_cache(maxsize=None)
def get_settings() -> Settings:
    database_url = os.environ.get("DATABASE_URL") or DEFAULT_DATABASE_URL
    return Settings(
        database_url=database_url,
        jwt_secret=load_jwt_secret(SECRETS_DIR),
        token_ttl_field_h=_env_int("MAATRIVA_TOKEN_TTL_FIELD_H", 168),
        token_ttl_staff_h=_env_int("MAATRIVA_TOKEN_TTL_STAFF_H", 12),
        demo=os.environ.get("MAATRIVA_DEMO", "0").strip() == "1",
        triage_interval_s=_env_int("MAATRIVA_TRIAGE_INTERVAL_S", 900),
        seed_today=_env_date("MAATRIVA_SEED_TODAY"),
    )
