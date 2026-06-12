"""AI safety primitives for StudyForge AI.

Defense-in-depth against prompt injection, PII leakage, and unsafe content
from uploaded materials. See docs/architecture/08-security-model.md.
"""

from .injection import (
    INJECTION_THRESHOLD as INJECTION_THRESHOLD,
)
from .injection import (
    InjectionFinding as InjectionFinding,
)
from .injection import (
    score_injection as score_injection,
)
from .pii import (
    PiiFinding as PiiFinding,
)
from .pii import (
    PiiKind as PiiKind,
)
from .pii import (
    RedactedText as RedactedText,
)
from .pii import (
    Redactor as Redactor,
)
from .prompt_builder import (
    ChannelMessage as ChannelMessage,
)
from .prompt_builder import (
    build_messages as build_messages,
)
