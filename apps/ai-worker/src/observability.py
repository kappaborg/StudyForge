"""Worker observability — OpenTelemetry traces + Sentry errors.

Both are opt-in:

  * Traces fire when ``OTEL_EXPORTER_OTLP_ENDPOINT`` is set. The default
    docker-compose ships Tempo + Grafana for self-hosters; without those
    services running, this is a no-op.
  * Sentry fires when ``SENTRY_DSN`` is set. We ship with
    ``send_default_pii=False`` and a custom ``before_send`` that scrubs
    chunk content + BYOK key tails from event payloads, so a developer
    accidentally putting a user's text in an exception message can't
    leak it past the SDK.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

# Keys we redact from any Sentry event payload, regardless of where they appear.
_SENSITIVE_KEYS = {
    "key",
    "api_key",
    "apiKey",
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "content",  # chunk text — never to telemetry
}


def setup_observability() -> None:
    """Initialise both backends. Safe to call multiple times.

    Call ONCE during process boot, before any user-facing route module
    is imported, so the SDK can hook the framework instrumentations.
    """
    _setup_otel()
    _setup_sentry()


def _setup_otel() -> None:
    import os

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (  # type: ignore[import-not-found]
            OTLPSpanExporter,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        log.warning("OTEL deps not installed; skipping trace setup")
        return
    provider = TracerProvider(
        resource=Resource.create({"service.name": "ai-worker"}),
    )
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    log.info("otel.enabled endpoint=%s", endpoint)


def _setup_sentry() -> None:
    import os

    dsn = os.environ.get("SENTRY_DSN")
    if not dsn:
        return
    try:
        import sentry_sdk
    except ImportError:
        log.warning("sentry-sdk not installed; skipping setup")
        return
    sentry_sdk.init(
        dsn=dsn,
        send_default_pii=False,
        traces_sample_rate=0.0,  # we use OTel for traces; Sentry is errors-only
        before_send=_scrub_event,  # type: ignore[arg-type]
        # Don't capture request bodies — they contain chunk content.
        max_request_body_size="never",
    )
    log.info("sentry.enabled errors-only")


def _scrub_event(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any] | None:
    """Recursively walk the event payload and replace any value at a
    sensitive key with ``[REDACTED]``. Pretty cheap because Sentry events
    are small dicts. Belt-and-braces over ``send_default_pii=False``.
    """
    _scrub(event)
    return event


def _scrub(node: Any) -> None:
    if isinstance(node, dict):
        for key in list(node.keys()):
            if isinstance(key, str) and key.lower() in _SENSITIVE_KEYS:
                node[key] = "[REDACTED]"
            else:
                _scrub(node[key])
    elif isinstance(node, list):
        for item in node:
            _scrub(item)


__all__ = ["setup_observability"]
