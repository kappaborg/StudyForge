"""Quiet-hours scheduler — timezone-aware, cross-midnight, deterministic."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from src.notifications.quiet_hours import QuietHours, schedule_delivery


def _utc(year: int, month: int, day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)


def test_no_quiet_hours_passes_through() -> None:
    when = _utc(2026, 5, 21, 23, 0)
    out = schedule_delivery(scheduled_for_utc=when, quiet_hours=None)
    assert out.send_at == when
    assert out.deferred is False


def test_outside_window_fires_immediately() -> None:
    qh = QuietHours(start="22:00", end="07:00", timezone="UTC")
    when = _utc(2026, 5, 21, 15, 0)  # 15:00 UTC, outside 22-07
    out = schedule_delivery(scheduled_for_utc=when, quiet_hours=qh)
    assert out.send_at == when
    assert out.deferred is False


def test_cross_midnight_window_defers_to_end() -> None:
    qh = QuietHours(start="22:00", end="07:00", timezone="UTC")
    when = _utc(2026, 5, 21, 23, 30)  # inside the 22-07 window
    out = schedule_delivery(scheduled_for_utc=when, quiet_hours=qh)
    assert out.deferred is True
    # End is 07:00 the next day in UTC.
    assert out.send_at == _utc(2026, 5, 22, 7, 0)


def test_window_evaluated_in_user_timezone() -> None:
    qh = QuietHours(start="22:00", end="07:00", timezone="Europe/Istanbul")  # UTC+3
    # 21:00 UTC == 00:00 next day Istanbul; inside the window.
    when = _utc(2026, 5, 21, 21, 0)
    out = schedule_delivery(scheduled_for_utc=when, quiet_hours=qh)
    assert out.deferred is True
    # 07:00 Istanbul == 04:00 UTC same morning.
    assert out.send_at == _utc(2026, 5, 22, 4, 0)


def test_same_day_window_defers_until_end() -> None:
    qh = QuietHours(start="13:00", end="14:00", timezone="UTC")
    when = _utc(2026, 5, 21, 13, 30)
    out = schedule_delivery(scheduled_for_utc=when, quiet_hours=qh)
    assert out.deferred is True
    assert out.send_at == _utc(2026, 5, 21, 14, 0)


def test_invalid_hhmm_rejected() -> None:
    qh = QuietHours(start="25:99", end="07:00", timezone="UTC")
    with pytest.raises(ValueError):
        schedule_delivery(scheduled_for_utc=_utc(2026, 5, 21, 23), quiet_hours=qh)


def test_naive_datetime_rejected() -> None:
    qh = QuietHours(start="22:00", end="07:00", timezone="UTC")
    with pytest.raises(ValueError):
        schedule_delivery(
            scheduled_for_utc=datetime(2026, 5, 21, 23, 0),
            quiet_hours=qh,
        )
