"""Request dependencies: authentication, role checks and role scoping
(Requirements 5.6–5.8, 6.1–6.3).

Usage in routers::

    router = APIRouter(dependencies=[Depends(get_current_user)])

    @router.get("/x", dependencies=[require_roles("doctor", "anm")])
    def x(user: CurrentUser = Depends(get_current_user), session=Depends(db.get_db)): ...

    @router.post("/y")
    def y(user: CurrentUser = require_roles("doctor")): ...

FastAPI caches dependencies per request, so ``get_current_user`` runs once even
when it is declared both on the router and through ``require_roles``.

Log calls here reference ids and roles only; never tokens or names (Req 46.4).
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from typing import Any, FrozenSet, Optional

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import false, select
from sqlalchemy.orm import Session

from app import db
from app.errors import forbidden, not_authenticated, not_found
from app.models import Facility, Mother, User, UserVillage, Village
from app.security import ROLES, AuthError, decode_token

log = logging.getLogger(__name__)

# auto_error=False: a missing or non-Bearer header yields None, which we map to
# our own 401 NOT_AUTHENTICATED (HTTPBearer's default would be a bare 403).
_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class CurrentUser:
    id: str
    role: str
    facility_id: Optional[str]
    village_ids: FrozenSet[str]
    username: str
    full_name: str
    facility_name: Optional[str]

    def to_out(self) -> dict[str, Any]:
        """The user object returned by login and ``GET /api/me`` (Req 5.3, 5.9)."""
        return {
            "id": self.id,
            "username": self.username,
            "full_name": self.full_name,
            "role": self.role,
            "facility_id": self.facility_id,
            "facility_name": self.facility_name,
            "village_ids": sorted(self.village_ids),
        }


def load_current_user(session: Session, user_id: str) -> Optional[CurrentUser]:
    """Build a ``CurrentUser`` from the database, or None if the user is unknown.

    ``village_ids`` keeps only assignments whose village belongs to the user's
    facility (Req 5.7); an admin (no facility) therefore has none.
    """
    user = session.get(User, user_id)
    if user is None:
        return None
    village_ids: FrozenSet[str] = frozenset()
    facility_name: Optional[str] = None
    if user.facility_id is not None:
        rows = session.execute(
            select(UserVillage.village_id)
            .join(Village, Village.id == UserVillage.village_id)
            .where(
                UserVillage.user_id == user.id,
                Village.facility_id == user.facility_id,
            )
        ).scalars()
        village_ids = frozenset(rows)
        facility = session.get(Facility, user.facility_id)
        facility_name = facility.name if facility is not None else None
    return CurrentUser(
        id=user.id,
        role=user.role,
        facility_id=user.facility_id,
        village_ids=village_ids,
        username=user.username,
        full_name=user.full_name,
        facility_name=facility_name,
    )


def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
    session: Session = Depends(db.get_db),
) -> CurrentUser:
    """401 ``NOT_AUTHENTICATED`` + ``WWW-Authenticate: Bearer`` when the token is
    missing, invalid or expired, or names an unknown user (Req 5.6)."""
    if credentials is None or not credentials.credentials:
        log.debug("auth: missing bearer token")
        raise not_authenticated()
    try:
        claims = decode_token(credentials.credentials)
    except AuthError as exc:
        log.debug("auth: rejected token (%s)", exc)
        raise not_authenticated() from None
    current = load_current_user(session, claims["sub"])
    if current is None or current.role not in ROLES:
        log.debug("auth: token for unknown user %s", claims["sub"])
        raise not_authenticated()
    return current


def require_roles(*roles: str) -> Any:
    """Return a ``Depends`` that yields the ``CurrentUser`` or raises 403
    ``FORBIDDEN`` when the caller's role is not in ``roles`` (Req 5.8)."""
    unknown = set(roles) - ROLES
    if not roles or unknown:
        raise ValueError(f"require_roles: bad roles {sorted(unknown) or roles!r}")
    allowed = frozenset(roles)

    def _check(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if user.role not in allowed:
            log.info("forbidden: user %s role %s", user.id, user.role)
            raise forbidden()
        return user

    _check.__name__ = f"require_roles_{'_'.join(sorted(allowed))}"
    return Depends(_check)


def mother_scope_filter(user: CurrentUser):
    """SQL criterion restricting ``Mother`` rows to the caller's scope (Req 6.2).

    ASHA: her assigned villages. Doctor / ANM: their facility. Admin: nothing.
    """
    if user.role == "asha":
        if not user.village_ids:
            return false()
        return Mother.village_id.in_(user.village_ids)
    if user.role in ("doctor", "anm"):
        if user.facility_id is None:
            return false()
        return Mother.facility_id == user.facility_id
    return false()


def normalize_id(value: Any) -> Optional[str]:
    """Lowercase canonical UUID string, or None if ``value`` is not a UUID."""
    if isinstance(value, uuid.UUID):
        return str(value)
    if not isinstance(value, str):
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


def get_mother_in_scope(session: Session, user: CurrentUser, mother_id: Any) -> Mother:
    """The Mother with ``mother_id`` if it exists and is in scope; otherwise 404
    ``NOT_FOUND``, identical for absent and out-of-scope ids (Req 6.3)."""
    mid = normalize_id(mother_id)
    if mid is None:
        raise not_found()
    mother = session.execute(
        select(Mother).where(Mother.id == mid, mother_scope_filter(user))
    ).scalar_one_or_none()
    if mother is None:
        raise not_found()
    return mother


__all__ = [
    "CurrentUser",
    "load_current_user",
    "get_current_user",
    "require_roles",
    "mother_scope_filter",
    "normalize_id",
    "get_mother_in_scope",
]
