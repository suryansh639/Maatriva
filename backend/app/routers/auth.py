"""Authentication routes (Requirements 5.3, 5.5, 5.9).

- ``POST /api/auth/login`` (unauthenticated): username + password → bearer JWT,
  ``expires_at`` and the user object. A wrong username and a wrong password get
  the same 401 ``INVALID_CREDENTIALS`` body; for an unknown username one
  ``verify_password`` still runs against a fixed dummy hash, so response timing
  does not reveal whether the user exists.
- ``GET /api/me`` (authenticated): the same user object as login.

Logs carry the username or user id only, never passwords or tokens (Req 46.4).
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, StrictStr
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import db
from app.deps import CurrentUser, get_current_user, load_current_user
from app.errors import DomainError
from app.models import User
from app.security import dummy_hash, issue_token, verify_password
from app.timeutil import iso_z

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["auth"])

INVALID_CREDENTIALS = "INVALID_CREDENTIALS"
INVALID_CREDENTIALS_MESSAGE = "Invalid username or password"


class LoginIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    username: StrictStr = Field(min_length=1, max_length=40)
    password: StrictStr = Field(min_length=1, max_length=128)


def _invalid_credentials() -> DomainError:
    return DomainError(401, INVALID_CREDENTIALS, INVALID_CREDENTIALS_MESSAGE)


@router.post("/auth/login")
def login(body: LoginIn, session: Session = Depends(db.get_db)) -> dict[str, Any]:
    user = session.execute(
        select(User).where(User.username == body.username)
    ).scalar_one_or_none()
    if user is None:
        verify_password(body.password, dummy_hash())  # equalize timing
        log.info("login failed for username %r", body.username)
        raise _invalid_credentials()
    if not verify_password(body.password, user.password_hash):
        log.info("login failed for username %r", body.username)
        raise _invalid_credentials()

    current = load_current_user(session, user.id)
    if current is None:  # deleted between the two reads
        raise _invalid_credentials()
    token, expires_at = issue_token(user)
    log.info("login ok for user %s (role %s)", user.id, user.role)
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_at": iso_z(expires_at),
        "user": current.to_out(),
    }


@router.get("/me")
def me(user: CurrentUser = Depends(get_current_user)) -> dict[str, Any]:
    return user.to_out()
