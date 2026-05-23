"""Shared cache helpers."""

from __future__ import annotations

import hashlib
from collections.abc import Iterable


def chunk_set_hash(chunk_ids: Iterable[str]) -> str:
    """sha256 of the sorted, deduplicated chunk-id list.

    Sorting + dedup makes the hash order-independent — the same set of chunks
    retrieved by different RRF orderings collapses to the same cache key.
    """
    deduped = sorted(set(chunk_ids))
    h = hashlib.sha256()
    for cid in deduped:
        h.update(cid.encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()
