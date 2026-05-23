"""Chunk content trimming for free-tier LLM TPM headroom.

Groq's free tier caps llama-3.1-8b-instant at 6000 tokens/minute. A
five-chunk retrieval with full chunk bodies routinely costs 4–5 K
tokens of input, which means consecutive requests trip 429. We trim
each chunk's content to a sentinel size before handing it to the
agents — most signal lives in the first 400–600 characters of a
chunk anyway, and the citation anchor still points to the full source.

When/if we move to a higher tier, set ``MAX_CHARS_PER_CHUNK`` higher
or remove the truncation entirely.
"""

from __future__ import annotations

MAX_CHARS_PER_CHUNK = 600


def trim_chunk_content(content: str) -> str:
    if len(content) <= MAX_CHARS_PER_CHUNK:
        return content
    return content[:MAX_CHARS_PER_CHUNK].rstrip() + "…"
