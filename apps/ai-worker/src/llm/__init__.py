"""LLM provider abstraction.

The single chokepoint between agents and provider SDKs. No business-logic
module imports a provider SDK directly — agents take an ``LLMProvider``
dependency. This is what makes the §13 cost-policy enforceable and what makes
prompt caching, semantic caching, and per-call telemetry universal.

This package exports:
  * the wire contracts (``LLMRequest`` / ``LLMResponse`` / ``LLMStreamChunk``)
  * the ``LLMProvider`` Protocol every adapter implements
  * concrete adapters (Groq, OpenAI, Anthropic; more behind the same shape)
  * the ``ProviderRegistry`` the orchestrator + router consume
"""

from .anthropic import (
    AnthropicProvider as AnthropicProvider,
)
from .anthropic import (
    AnthropicRequestError as AnthropicRequestError,
)
from .contracts import (
    ChannelMessage as ChannelMessage,
)
from .contracts import (
    LLMProvider as LLMProvider,
)
from .contracts import (
    LLMRequest as LLMRequest,
)
from .contracts import (
    LLMResponse as LLMResponse,
)
from .contracts import (
    LLMStreamChunk as LLMStreamChunk,
)
from .contracts import (
    LLMUsage as LLMUsage,
)
from .contracts import (
    Role as Role,
)
from .groq import GroqProvider as GroqProvider
from .groq import GroqRequestError as GroqRequestError
from .openai import OpenAIProvider as OpenAIProvider
from .openai_compat import (
    OpenAICompatibleProvider as OpenAICompatibleProvider,
)
from .openai_compat import (
    OpenAICompatRequestError as OpenAICompatRequestError,
)
from .registry import (
    ProviderCredentials as ProviderCredentials,
)
from .registry import (
    ProviderRegistry as ProviderRegistry,
)
