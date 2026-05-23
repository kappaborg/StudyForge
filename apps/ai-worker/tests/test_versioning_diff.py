"""Artifact diff — the regeneration UX depends on these being right."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from src.versioning import diff_artifacts


@dataclass(frozen=True)
class Flashcard:
    concept_id: str
    front: str
    back: str


def _key(card: Flashcard) -> str:
    return card.concept_id


def _fingerprint(card: Flashcard) -> str:
    return f"{card.front}||{card.back}"


def test_diff_detects_added_removed_changed_unchanged() -> None:
    old = [
        Flashcard("c1", "What is X?", "X is a thing."),
        Flashcard("c2", "What is Y?", "Y is another thing."),
        Flashcard("c3", "What is Z?", "Z is a third thing."),
    ]
    new = [
        # c1 unchanged
        Flashcard("c1", "What is X?", "X is a thing."),
        # c2 changed (back rewritten)
        Flashcard("c2", "What is Y?", "Y is yet another thing."),
        # c3 removed
        # c4 added
        Flashcard("c4", "What is W?", "W is new."),
    ]
    diff = diff_artifacts(old=old, new=new, key=_key, fingerprint=_fingerprint)
    assert [c.concept_id for c in diff.added] == ["c4"]
    assert [c.concept_id for c in diff.removed] == ["c3"]
    assert [pair[1].concept_id for pair in diff.changed] == ["c2"]
    assert [c.concept_id for c in diff.unchanged] == ["c1"]
    assert diff.has_changes is True


def test_diff_is_empty_when_no_changes() -> None:
    cards = [Flashcard("c1", "X", "x"), Flashcard("c2", "Y", "y")]
    diff = diff_artifacts(old=cards, new=cards, key=_key, fingerprint=_fingerprint)
    assert diff.has_changes is False
    assert diff.summary() == "+0 added, -0 removed, ~0 changed, =2 unchanged"


def test_diff_rejects_duplicate_keys() -> None:
    dup = [Flashcard("c1", "X", "x"), Flashcard("c1", "X-dupe", "x")]
    with pytest.raises(ValueError, match="duplicate key"):
        diff_artifacts(old=dup, new=[], key=_key, fingerprint=_fingerprint)


def test_diff_is_deterministic_across_input_order() -> None:
    a = [
        Flashcard("c2", "Y", "y"),
        Flashcard("c1", "X", "x"),
    ]
    b = [
        Flashcard("c1", "X-new", "x"),
        Flashcard("c3", "Z", "z"),
    ]
    d1 = diff_artifacts(old=a, new=b, key=_key, fingerprint=_fingerprint)
    d2 = diff_artifacts(old=list(reversed(a)), new=list(reversed(b)), key=_key, fingerprint=_fingerprint)
    assert [c.concept_id for c in d1.added] == [c.concept_id for c in d2.added]
    assert [c.concept_id for c in d1.removed] == [c.concept_id for c in d2.removed]
    assert [p[1].concept_id for p in d1.changed] == [p[1].concept_id for p in d2.changed]
