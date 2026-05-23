"""Tier policy loader.

Validates the YAML at boot. The CI loader runs the same validation; a malformed
production policy fails to load before any traffic touches the worker.

Invariants:
  * ``free`` tier MUST NOT have ``on_exhaust = block``.
  * ``warn_threshold_pct`` is in [50, 99].
  * ``daily_tokens >= -1`` (-1 means unlimited).
"""

from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from typing import Annotated

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator


class ExhaustPolicy(StrEnum):
    downshift = "downshift"
    rate_limit = "rate_limit"
    block = "block"


class BillingParty(StrEnum):
    platform = "platform"
    user = "user"
    institution = "institution"


class TierName(StrEnum):
    free = "free"
    pro = "pro"
    byok = "byok"
    institutional = "institutional"


class TierConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    daily_tokens: int = Field(ge=-1)
    monthly_tokens: int = Field(ge=-1)
    providers: list[str] = Field(min_length=1)
    on_exhaust: ExhaustPolicy
    billing: BillingParty


class TierPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tiers: dict[TierName, TierConfig]
    warn_threshold_pct: Annotated[int, Field(ge=50, le=99)] = 80

    @model_validator(mode="after")
    def _free_tier_must_not_block(self) -> "TierPolicy":
        free = self.tiers.get(TierName.free)
        if free is not None and free.on_exhaust is ExhaustPolicy.block:
            raise ValueError(
                "free tier on_exhaust must be 'downshift' or 'rate_limit', not 'block'; "
                "blocking free users contradicts Operating Principle 11."
            )
        return self

    @model_validator(mode="after")
    def _tiers_cover_known_names(self) -> "TierPolicy":
        # Allow partial coverage in tests; missing tiers are treated as "not
        # offered" at runtime. We just sanity-check that what's present is
        # internally consistent.
        for name, tier in self.tiers.items():
            if name is TierName.byok and tier.billing is not BillingParty.user:
                raise ValueError("byok tier must have billing='user'")
            if name is TierName.institutional and tier.billing is not BillingParty.institution:
                raise ValueError("institutional tier must have billing='institution'")
        return self


def load_tier_policy(path: str | Path) -> TierPolicy:
    raw = Path(path).read_text(encoding="utf-8")
    data = yaml.safe_load(raw)
    if not isinstance(data, dict):
        raise ValueError(f"tier policy at {path} must be a YAML mapping")
    return TierPolicy.model_validate(data)
