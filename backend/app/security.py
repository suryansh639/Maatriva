"""Password hashing and JWT handling (Requirement 5).

Passwords: PBKDF2-SHA256 from the standard library, stored as
``pbkdf2_sha256$<iterations>$<salt_b64>$<hash_b64>`` (standard base64).

Tokens: HS256 JWTs with the claims ``sub`` (user id), ``role``, ``fac``
(facility id, null for admin), ``iat`` and ``exp`` (epoch seconds). Field
roles (asha, anm) get ``token_ttl_field_h``; staff roles (doctor, admin) get
``token_ttl_staff_h``.

Nothing in this module logs passwords or tokens (Req 46.4).
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any, Optional, Protocol, Tuple

import jwt

from app.config import Settings, get_settings
from app.timeutil import to_utc_naive, utcnow

ALGORITHM = "pbkdf2_sha256"
DEFAULT_ITERATIONS = 200_000
SALT_BYTES = 16
JWT_ALGORITHM = "HS256"

FIELD_ROLES = frozenset({"asha", "anm"})
STAFF_ROLES = frozenset({"doctor", "admin"})
ROLES = FIELD_ROLES | STAFF_ROLES

# Upper bound on the iteration count accepted from a stored hash, so a
# corrupted row cannot make one verification run for minutes.
_MAX_ITERATIONS = 10_000_000


class AuthError(Exception):
    """Token missing, invalid, expired or malformed. Mapped to 401 by deps."""


class TokenUser(Protocol):
    id: str
    role: str
    facility_id: Optional[str]


def _b64e(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _b64d(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"), validate=True)


def hash_password(pw: str, *, iterations: int = DEFAULT_ITERATIONS) -> str:
    """Hash ``pw`` with a fresh 16-byte salt. ``iterations`` is lowered only in tests."""
    if iterations < 1:
        raise ValueError("iterations must be >= 1")
    salt = secrets.token_bytes(SALT_BYTES)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, iterations)
    return f"{ALGORITHM}${iterations}${_b64e(salt)}${_b64e(dk)}"


def verify_password(pw: str, stored: str) -> bool:
    """Constant-time check of ``pw`` against ``stored``. False on any malformed input."""
    try:
        algo, it_text, salt_text, hash_text = stored.split("$")
        if algo != ALGORITHM or not it_text.isdigit():
            return False
        iterations = int(it_text)
        if iterations < 1 or iterations > _MAX_ITERATIONS:
            return False
        salt = _b64d(salt_text)
        expected = _b64d(hash_text)
        if not salt or not expected:
            return False
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, iterations)
    except (AttributeError, TypeError, ValueError, binascii.Error, UnicodeError):
        return False
    return hmac.compare_digest(dk, expected)


@lru_cache(maxsize=1)
def dummy_hash() -> str:
    """A fixed-cost hash for the unknown-user login path, so timing does not
    reveal whether a username exists (design §5)."""
    return hash_password(secrets.token_hex(16))


def token_ttl(role: str, settings: Settings) -> timedelta:
    if role in FIELD_ROLES:
        return timedelta(hours=settings.token_ttl_field_h)
    if role in STAFF_ROLES:
        return timedelta(hours=settings.token_ttl_staff_h)
    raise ValueError(f"unknown role {role!r}")


def issue_token(
    user: TokenUser,
    settings: Optional[Settings] = None,
    now: Optional[datetime] = None,
) -> Tuple[str, datetime]:
    """Return ``(jwt, expires_at)``; ``expires_at`` is naive UTC, whole seconds."""
    settings = settings or get_settings()
    now = to_utc_naive(now) if now is not None else utcnow()
    iat = int(now.replace(tzinfo=timezone.utc).timestamp())
    exp = iat + int(token_ttl(user.role, settings).total_seconds())
    payload = {
        "sub": str(user.id),
        "role": user.role,
        "fac": user.facility_id,
        "iat": iat,
        "exp": exp,
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm=JWT_ALGORITHM)
    expires_at = datetime.fromtimestamp(exp, timezone.utc).replace(tzinfo=None)
    return token, expires_at


def decode_token(token: str, settings: Optional[Settings] = None) -> dict[str, Any]:
    """Verify signature, algorithm and expiry; return the claims or raise AuthError."""
    settings = settings or get_settings()
    if not isinstance(token, str) or not token:
        raise AuthError("missing token")
    try:
        claims = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[JWT_ALGORITHM],
            options={"require": ["sub", "role", "iat", "exp"]},
        )
    except jwt.PyJWTError as exc:
        raise AuthError(type(exc).__name__) from None
    if not isinstance(claims.get("sub"), str) or claims.get("role") not in ROLES:
        raise AuthError("bad claims")
    if "fac" not in claims or not (claims["fac"] is None or isinstance(claims["fac"], str)):
        raise AuthError("bad claims")
    return claims
