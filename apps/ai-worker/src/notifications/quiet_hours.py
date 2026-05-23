"""Quiet-hours evaluator for the notification worker.

Determines whether a scheduled notification should fire immediately or be
deferred until the user's quiet window ends. Timezone-aware via Python's
``zoneinfo``; deterministic — no clock dependency inside.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

_HHMM_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


@dataclass(frozen=True)
class QuietHours:
    """A user's quiet window. ``start`` and ``end`` are local wall-clock times
    in ``timezone``. Cross-midnight windows are supported (e.g. 22:00 → 07:00)."""

    start: str  # "HH:MM"
    end: str
    timezone: str

    def parsed_start(self) -> time:
        return _parse_hhmm(self.start)

    def parsed_end(self) -> time:
        return _parse_hhmm(self.end)


@dataclass(frozen=True)
class Delivery:
    send_at: datetime
    """UTC instant the worker should fire the notification."""

    deferred: bool


def schedule_delivery(
    *,
    scheduled_for_utc: datetime,
    quiet_hours: QuietHours | None,
) -> Delivery:
    """Return when the notification should actually fire.

    If ``quiet_hours`` is ``None`` or the requested time falls outside the
    window, the same instant is returned with ``deferred = False``. Otherwise
    the delivery is bumped to the window's end, in UTC, with ``deferred = True``.
    """
    if scheduled_for_utc.tzinfo is None:
        raise ValueError("scheduled_for_utc must be timezone-aware (UTC)")
    if quiet_hours is None:
        return Delivery(send_at=scheduled_for_utc, deferred=False)

    tz = ZoneInfo(quiet_hours.timezone)
    local = scheduled_for_utc.astimezone(tz)
    start = quiet_hours.parsed_start()
    end = quiet_hours.parsed_end()

    if not _is_in_window(local.time(), start, end):
        return Delivery(send_at=scheduled_for_utc, deferred=False)

    next_end_local = _next_window_end(local, start, end)
    return Delivery(send_at=next_end_local.astimezone(scheduled_for_utc.tzinfo), deferred=True)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _parse_hhmm(value: str) -> time:
    match = _HHMM_RE.match(value)
    if match is None:
        raise ValueError(f"expected HH:MM, got {value!r}")
    hour = int(match.group(1))
    minute = int(match.group(2))
    return time(hour=hour, minute=minute)


def _is_in_window(t: time, start: time, end: time) -> bool:
    if start <= end:
        return start <= t < end
    # Cross-midnight: [start, 24:00) ∪ [00:00, end)
    return t >= start or t < end


def _next_window_end(now_local: datetime, start: time, end: time) -> datetime:
    """Return the next local datetime equal to ``end`` after ``now_local``."""
    candidate = now_local.replace(
        hour=end.hour, minute=end.minute, second=0, microsecond=0
    )
    if start <= end:
        # Same-day window. If now is after end (shouldn't happen because we
        # checked _is_in_window) we'd return tomorrow.
        if candidate <= now_local:
            candidate = candidate + timedelta(days=1)
        return candidate
    # Cross-midnight: end is "tomorrow morning" if now is past midnight.
    if now_local.time() >= start:
        candidate = candidate + timedelta(days=1)
    return candidate
