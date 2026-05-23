"""Golden-set JSONL loader.

Each line of ``cases.jsonl`` is one ``GoldenCase`` serialised with the same
field names as the dataclass. Blank lines + ``#`` comment lines are skipped
so reviewers can annotate the file.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .contracts import GoldenCase, GoldenChunk


def load_golden_set(path: str | Path) -> list[GoldenCase]:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"golden set not found: {p}")
    cases: list[GoldenCase] = []
    seen_ids: set[str] = set()
    for line_number, raw in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{p}:{line_number}: invalid JSON — {exc}") from exc
        case = _to_case(obj, path=p, line_number=line_number)
        if case.case_id in seen_ids:
            raise ValueError(f"{p}:{line_number}: duplicate case_id {case.case_id!r}")
        seen_ids.add(case.case_id)
        cases.append(case)
    return cases


def _to_case(obj: dict[str, Any], *, path: Path, line_number: int) -> GoldenCase:
    try:
        chunks_raw = obj.get("chunks") or []
        chunks = tuple(
            GoldenChunk(
                chunk_id=str(c["chunk_id"]),
                content=str(c["content"]),
                score=float(c.get("score", 0.9)),
                page=c.get("page"),
                doc_id=str(c.get("doc_id", "golden-doc")),
                version_id=str(c.get("version_id", "golden-version")),
            )
            for c in chunks_raw
        )
        return GoldenCase(
            case_id=str(obj["case_id"]),
            query=str(obj["query"]),
            chunks=chunks,
            expect_refusal=bool(obj.get("expect_refusal", False)),
            expected_chunks=tuple(str(c) for c in obj.get("expected_chunks") or ()),
            must_not_contain=tuple(str(p) for p in obj.get("must_not_contain") or ()),
            model_response=obj.get("model_response"),
            notes=obj.get("notes"),
        )
    except KeyError as exc:
        raise ValueError(
            f"{path}:{line_number}: missing required field {exc.args[0]!r}"
        ) from exc
