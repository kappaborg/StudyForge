"""Course-shared artifact cache — Phase 2 §13.

Covers the in-memory backend (used by tests + the dev loop without
Postgres) end-to-end: lookup misses, store + hit, hit-count increment,
unique-key isolation across agent/version pairs, the
``require_validated`` filter, and the monotonic ``mark_validated``
transition. Postgres parity is verified by the integration smoke job;
this suite is the unit-level contract.
"""

from __future__ import annotations

import pytest

from src.cache import InMemoryArtifactCache


@pytest.mark.asyncio
async def test_lookup_returns_none_when_no_row() -> None:
    cache = InMemoryArtifactCache()
    assert (
        await cache.lookup(
            content_hash="h",
            agent_name="flashcard.generate.v1",
            agent_version="0.1.0",
        )
        is None
    )


@pytest.mark.asyncio
async def test_store_then_lookup_returns_hit() -> None:
    cache = InMemoryArtifactCache()
    await cache.store(
        content_hash="h",
        agent_name="flashcard.generate.v1",
        agent_version="0.1.0",
        output={"deck_title": "Bio basics", "flashcards": []},
        donor_tenant_id="tenant-A",
        donor_course_id="course-A",
    )
    hit = await cache.lookup(
        content_hash="h",
        agent_name="flashcard.generate.v1",
        agent_version="0.1.0",
    )
    assert hit is not None
    assert hit.output == {"deck_title": "Bio basics", "flashcards": []}
    assert hit.donor_tenant_id == "tenant-A"
    assert hit.donor_course_id == "course-A"
    assert hit.quality_validated is False
    assert hit.hits == 1


@pytest.mark.asyncio
async def test_lookup_increments_hit_count_monotonically() -> None:
    cache = InMemoryArtifactCache()
    await cache.store(
        content_hash="h",
        agent_name="agent",
        agent_version="v1",
        output={"x": 1},
        donor_tenant_id="t",
        donor_course_id=None,
    )
    for expected in (1, 2, 3):
        hit = await cache.lookup(
            content_hash="h", agent_name="agent", agent_version="v1"
        )
        assert hit is not None
        assert hit.hits == expected


@pytest.mark.asyncio
async def test_lookup_misses_when_agent_name_differs() -> None:
    cache = InMemoryArtifactCache()
    await cache.store(
        content_hash="h",
        agent_name="flashcard.generate.v1",
        agent_version="0.1.0",
        output={"x": 1},
        donor_tenant_id="t",
        donor_course_id=None,
    )
    assert (
        await cache.lookup(
            content_hash="h",
            agent_name="quiz.generate.v1",  # different agent
            agent_version="0.1.0",
        )
        is None
    )


@pytest.mark.asyncio
async def test_lookup_misses_when_agent_version_differs() -> None:
    cache = InMemoryArtifactCache()
    await cache.store(
        content_hash="h",
        agent_name="agent",
        agent_version="0.1.0",
        output={"x": 1},
        donor_tenant_id="t",
        donor_course_id=None,
    )
    # A version bump invalidates the cache by design — output format may
    # have changed in a way the consumer can't tell from the JSON alone.
    assert (
        await cache.lookup(
            content_hash="h", agent_name="agent", agent_version="0.2.0"
        )
        is None
    )


# ─────────────────────────────────────────────────────────────────────────────
# require_validated filter — Phase 2 exit criterion
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unvalidated_row_hides_under_require_validated() -> None:
    cache = InMemoryArtifactCache()
    await cache.store(
        content_hash="h",
        agent_name="agent",
        agent_version="v1",
        output={"x": 1},
        donor_tenant_id="t",
        donor_course_id=None,
        quality_validated=False,
    )
    assert (
        await cache.lookup(
            content_hash="h",
            agent_name="agent",
            agent_version="v1",
            require_validated=True,
        )
        is None
    )
    # Same row is visible without the filter.
    visible = await cache.lookup(
        content_hash="h", agent_name="agent", agent_version="v1"
    )
    assert visible is not None


@pytest.mark.asyncio
async def test_validated_row_is_visible_to_strict_consumers() -> None:
    cache = InMemoryArtifactCache()
    await cache.store(
        content_hash="h",
        agent_name="agent",
        agent_version="v1",
        output={"x": 1},
        donor_tenant_id="t",
        donor_course_id=None,
        quality_validated=True,
    )
    hit = await cache.lookup(
        content_hash="h",
        agent_name="agent",
        agent_version="v1",
        require_validated=True,
    )
    assert hit is not None
    assert hit.quality_validated is True


# ─────────────────────────────────────────────────────────────────────────────
# mark_validated — monotonic transition, no-op on missing
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_mark_validated_flips_flag_and_is_idempotent() -> None:
    cache = InMemoryArtifactCache()
    await cache.store(
        content_hash="h",
        agent_name="agent",
        agent_version="v1",
        output={"x": 1},
        donor_tenant_id="t",
        donor_course_id=None,
        quality_validated=False,
    )
    await cache.mark_validated(content_hash="h", agent_name="agent", agent_version="v1")
    # Second call is a no-op (no exception, still True).
    await cache.mark_validated(content_hash="h", agent_name="agent", agent_version="v1")

    hit = await cache.lookup(
        content_hash="h",
        agent_name="agent",
        agent_version="v1",
        require_validated=True,
    )
    assert hit is not None and hit.quality_validated is True


@pytest.mark.asyncio
async def test_mark_validated_on_missing_row_does_not_raise() -> None:
    cache = InMemoryArtifactCache()
    await cache.mark_validated(content_hash="nope", agent_name="agent", agent_version="v1")
    # Confirm we didn't accidentally create a row.
    assert await cache.lookup(content_hash="nope", agent_name="agent", agent_version="v1") is None


# ─────────────────────────────────────────────────────────────────────────────
# Re-store semantics — donor preserved, quality monotonic, output refreshed
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_restore_preserves_first_donor_and_refreshes_output() -> None:
    cache = InMemoryArtifactCache()
    await cache.store(
        content_hash="h",
        agent_name="agent",
        agent_version="v1",
        output={"v": 1},
        donor_tenant_id="tenant-FIRST",
        donor_course_id="course-FIRST",
    )
    await cache.store(
        content_hash="h",
        agent_name="agent",
        agent_version="v1",
        output={"v": 2},
        donor_tenant_id="tenant-SECOND",
        donor_course_id="course-SECOND",
    )
    hit = await cache.lookup(
        content_hash="h", agent_name="agent", agent_version="v1"
    )
    assert hit is not None
    # Donor is the FIRST writer (audit trail), not overwritten.
    assert hit.donor_tenant_id == "tenant-FIRST"
    assert hit.donor_course_id == "course-FIRST"
    # Output IS the refreshed version (schema bump scenario).
    assert hit.output == {"v": 2}


@pytest.mark.asyncio
async def test_quality_validated_is_monotonic_under_restore() -> None:
    cache = InMemoryArtifactCache()
    await cache.store(
        content_hash="h",
        agent_name="agent",
        agent_version="v1",
        output={"x": 1},
        donor_tenant_id="t",
        donor_course_id=None,
        quality_validated=True,
    )
    # A later regeneration with quality_validated=False MUST NOT revert
    # the validated flag — the donor's eval already passed; subsequent
    # writers don't have authority to invalidate that.
    await cache.store(
        content_hash="h",
        agent_name="agent",
        agent_version="v1",
        output={"x": 2},
        donor_tenant_id="t",
        donor_course_id=None,
        quality_validated=False,
    )
    hit = await cache.lookup(
        content_hash="h",
        agent_name="agent",
        agent_version="v1",
        require_validated=True,
    )
    assert hit is not None and hit.quality_validated is True
