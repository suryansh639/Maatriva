"""Role and facility scoping of the doctor routes (Requirements 6.1, 6.3–6.5, 44.3).

The SSE stream is only probed with roles that get 403 before streaming starts;
a doctor stream is never opened here (it would block the TestClient).
"""
from __future__ import annotations

from datetime import timedelta

import pytest

from app.models import new_uuid
from app.timeutil import today_ist
from tests.test_alerts import alerts, sms
from tests.test_outcomes import outcome_body
from tests.test_tasks import body as task_body
from tests.test_triage_service import add_visit, triage

DASHBOARD_GETS = [
    "/api/dashboard/census",
    "/api/dashboard/queue",
    "/api/notifications",
    "/api/digest",
    "/api/outcomes",
    "/api/tasks",
]


def assert_code(resp, status: int, code: str) -> None:
    assert resp.status_code == status, resp.text
    assert resp.json()["detail"]["code"] == code


@pytest.fixture
def red_a(world):
    """A RED mother of facility A with an open RED alert (and doctor SMS)."""
    m = world.a.mothers[0]
    add_visit(m, days_ago=1)
    add_visit(m, hb=6.5)
    triage(m.id)
    return m


# --------------------------------------------------------------------------- 404


def test_other_facilitys_mother_is_404(client, world, red_a, auth_headers):
    b_doctor = auth_headers(world.b.doctor)
    for mother_id in (red_a.id, new_uuid(), "not-a-uuid"):
        assert_code(client.get(f"/api/mothers/{mother_id}", headers=b_doctor), 404, "NOT_FOUND")
        assert_code(
            client.post(f"/api/mothers/{mother_id}/tasks", json=task_body(), headers=b_doctor),
            404,
            "NOT_FOUND",
        )
        assert_code(
            client.post(f"/api/mothers/{mother_id}/birth-outcome", json=outcome_body(), headers=b_doctor),
            404,
            "NOT_FOUND",
        )
    assert_code(
        client.get(f"/api/mothers/{red_a.id}", headers=auth_headers(world.b.anm)), 404, "NOT_FOUND"
    )
    # Nothing was written for A's mother, and her own doctor still sees her.
    assert alerts(red_a.id)[0].status == "open"
    assert sms("task_assigned") == []
    assert client.get(f"/api/mothers/{red_a.id}", headers=auth_headers(world.a.doctor)).status_code == 200


def test_other_facilitys_alert_ack_is_404(client, world, red_a, auth_headers):
    [alert] = alerts(red_a.id)
    resp = client.post(f"/api/alerts/{alert.id}/ack", headers=auth_headers(world.b.doctor))
    assert_code(resp, 404, "NOT_FOUND")
    assert alerts(red_a.id)[0].status == "open"


# --------------------------------------------------------------------------- 403


@pytest.mark.parametrize("path", DASHBOARD_GETS + ["/api/mothers/{id}"])
def test_asha_on_dashboard_is_403(client, world, auth_headers, path):
    path = path.replace("{id}", world.a.mothers[0].id)
    assert_code(client.get(path, headers=auth_headers(world.a.asha)), 403, "FORBIDDEN")


def test_asha_cannot_write_doctor_routes(client, world, auth_headers):
    headers = auth_headers(world.a.asha)
    mid = world.a.mothers[0].id
    assert_code(client.post(f"/api/mothers/{mid}/tasks", json=task_body(), headers=headers), 403, "FORBIDDEN")
    assert_code(client.post("/api/digest/send", headers=headers), 403, "FORBIDDEN")


@pytest.mark.parametrize("path", DASHBOARD_GETS)
def test_admin_on_dashboard_is_403(client, world, auth_headers, path):
    assert_code(client.get(path, headers=auth_headers(world.admin)), 403, "FORBIDDEN")


def test_anm_is_403_on_doctor_only_routes(client, world, red_a, auth_headers):
    anm = auth_headers(world.a.anm)
    [alert] = alerts(red_a.id)

    assert_code(client.post(f"/api/mothers/{red_a.id}/tasks", json=task_body(), headers=anm), 403, "FORBIDDEN")
    assert_code(
        client.post(f"/api/mothers/{red_a.id}/birth-outcome", json=outcome_body(), headers=anm),
        403,
        "FORBIDDEN",
    )
    assert_code(client.get("/api/alerts", headers=anm), 403, "FORBIDDEN")
    assert_code(client.post(f"/api/alerts/{alert.id}/ack", headers=anm), 403, "FORBIDDEN")
    stream = client.get("/api/alerts/stream", headers=anm)
    assert_code(stream, 403, "FORBIDDEN")
    assert not stream.headers["content-type"].startswith("text/event-stream")

    # Nothing changed: no task, the alert is still open.
    assert sms("task_assigned") == []
    assert alerts(red_a.id)[0].status == "open"
    # The ANM's read-only routes still work.
    for path in DASHBOARD_GETS + [f"/api/mothers/{red_a.id}"]:
        assert client.get(path, headers=anm).status_code == 200, path


def test_asha_stream_is_403(client, world, auth_headers):
    assert_code(client.get("/api/alerts/stream", headers=auth_headers(world.a.asha)), 403, "FORBIDDEN")


def test_unauthenticated_dashboard_is_401(client):
    resp = client.get("/api/dashboard/census")
    assert_code(resp, 401, "NOT_AUTHENTICATED")
    assert resp.headers["www-authenticate"] == "Bearer"


# --------------------------------------------------------------------------- facility isolation


def test_facility_b_doctor_sees_none_of_facility_a_sms(client, world, red_a, auth_headers):
    a_headers = auth_headers(world.a.doctor)
    resp = client.post(
        f"/api/mothers/{red_a.id}/tasks",
        json=task_body(due_date=(today_ist() + timedelta(days=3)).isoformat()),
        headers=a_headers,
    )
    assert resp.status_code == 201
    a_rows = client.get("/api/notifications", headers=a_headers).json()
    assert {r["kind"] for r in a_rows} == {"red_alert", "task_assigned"}

    assert client.get("/api/notifications", headers=auth_headers(world.b.doctor)).json() == []
    assert client.get("/api/notifications", headers=auth_headers(world.b.anm)).json() == []
    # Facility B's alert list, queue and digest show none of A's data either.
    b_doctor = auth_headers(world.b.doctor)
    assert client.get("/api/alerts?status=all", headers=b_doctor).json() == []
    assert red_a.id not in {r["mother_id"] for r in client.get("/api/dashboard/queue", headers=b_doctor).json()}
    assert client.get("/api/tasks", headers=b_doctor).json() == []
