"""AI safety primitives for StudyForge AI.

Defense-in-depth against prompt injection, PII leakage, and unsafe content
from uploaded materials. See docs/architecture/08-security-model.md.
"""

from .injection import (
    INJECTION_THRESHOLD as INJECTION_THRESHOLD,
    InjectionFinding as InjectionFinding,
    score_injection as score_injection,
)
from .pii import (
    PiiFinding as PiiFinding,
    PiiKind as PiiKind,
    RedactedText as RedactedText,
    Redactor as Redactor,
)
from .prompt_builder import (
    ChannelMessage as ChannelMessage,
    build_messages as build_messages,
)
