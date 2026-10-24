"""Domain errors (Requirement 46.1).

``DomainError(status, code, message)`` renders as
``{"detail": {"code": "...", "message": "..."}}`` with HTTP ``status``.

It subclasses FastAPI's ``HTTPException`` with that ``detail`` dict, so even
FastAPI's default HTTPException handler produces the right body and forwards
``headers`` (for example ``WWW-Authenticate: Bearer`` on 401). ``main.py`` may
still register ``domain_error_handler`` explicitly; the output is the same.
"""
from __future__ import annotations

from typing import Any, Dict, Mapping, Optional

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse


class DomainError(HTTPException):
    """An expected, client-facing error with a stable machine-readable ``code``."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        super().__init__(
            status_code=status,
            detail={"code": code, "message": message},
            headers=dict(headers) if headers else None,
        )
        self.status = status
        self.code = code
        self.message = message

    def body(self) -> Dict[str, Any]:
        return {"detail": {"code": self.code, "message": self.message}}

    def __repr__(self) -> str:  # never includes request data
        return f"DomainError(status={self.status}, code={self.code!r})"


def domain_error_handler(_request: Request, exc: DomainError) -> JSONResponse:
    """Exception handler for ``app.add_exception_handler(DomainError, ...)``."""
    return JSONResponse(status_code=exc.status, content=exc.body(), headers=exc.headers)


# Common errors, so every call site uses the same code and message.
NOT_AUTHENTICATED = "NOT_AUTHENTICATED"
FORBIDDEN = "FORBIDDEN"
NOT_FOUND = "NOT_FOUND"


def not_authenticated() -> DomainError:
    return DomainError(
        401, NOT_AUTHENTICATED, "Not authenticated", headers={"WWW-Authenticate": "Bearer"}
    )


def forbidden() -> DomainError:
    return DomainError(403, FORBIDDEN, "Not allowed for this role")


def not_found() -> DomainError:
    return DomainError(404, NOT_FOUND, "Not found")


__all__ = [
    "DomainError",
    "domain_error_handler",
    "NOT_AUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "not_authenticated",
    "forbidden",
    "not_found",
]
