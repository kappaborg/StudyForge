"""Diff two snapshots of generated artifacts (flashcards / quiz items / etc.).

Used by the regenerate-course workflow: ingest writes a new ``DocumentVersion``,
agents re-run, and the UI shows the student a precise summary of what changed.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Generic, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class ArtifactDiff(Generic[T]):
    added: list[T]
    removed: list[T]
    changed: list[tuple[T, T]]  # (old, new) pairs sharing the same key
    unchanged: list[T]

    @property
    def has_changes(self) -> bool:
        return bool(self.added) or bool(self.removed) or bool(self.changed)

    def summary(self) -> str:
        """One-line human summary suitable for the in-app inbox."""
        return (
            f"+{len(self.added)} added, "
            f"-{len(self.removed)} removed, "
            f"~{len(self.changed)} changed, "
            f"={len(self.unchanged)} unchanged"
        )


def diff_artifacts(
    *,
    old: Iterable[T],
    new: Iterable[T],
    key: Callable[[T], str],
    fingerprint: Callable[[T], str],
) -> ArtifactDiff[T]:
    """Diff two artifact lists by stable key and content fingerprint.

    ``key`` should return a stable identity (e.g. ``flashcard.concept_id``);
    ``fingerprint`` should return a content hash that changes when the
    artifact's meaningful fields change. Two artifacts with the same key
    but different fingerprints are reported as *changed*.
    """
    old_by_key: dict[str, T] = {}
    for item in old:
        k = key(item)
        if k in old_by_key:
            raise ValueError(f"duplicate key in old: {k!r}")
        old_by_key[k] = item

    new_by_key: dict[str, T] = {}
    for item in new:
        k = key(item)
        if k in new_by_key:
            raise ValueError(f"duplicate key in new: {k!r}")
        new_by_key[k] = item

    added: list[T] = []
    removed: list[T] = []
    changed: list[tuple[T, T]] = []
    unchanged: list[T] = []

    for k, new_item in new_by_key.items():
        old_item = old_by_key.get(k)
        if old_item is None:
            added.append(new_item)
        elif fingerprint(old_item) != fingerprint(new_item):
            changed.append((old_item, new_item))
        else:
            unchanged.append(new_item)

    for k, old_item in old_by_key.items():
        if k not in new_by_key:
            removed.append(old_item)

    # Determinism: sort by key so the diff is reproducible.
    added.sort(key=key)
    removed.sort(key=key)
    changed.sort(key=lambda pair: key(pair[1]))
    unchanged.sort(key=key)

    return ArtifactDiff(
        added=added,
        removed=removed,
        changed=changed,
        unchanged=unchanged,
    )
