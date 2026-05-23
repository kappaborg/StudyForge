"""PII detection + reversible-token redaction."""

from __future__ import annotations

from src.safety.pii import PiiKind, Redactor


def test_redactor_finds_email_and_emits_stable_token() -> None:
    redactor = Redactor()
    result = redactor.redact("Contact me at alice@example.com please.")
    assert len(result.findings) == 1
    finding = result.findings[0]
    assert finding.kind is PiiKind.email
    assert finding.token in result.text
    assert "alice@example.com" not in result.text

    # Same input → same token across calls on a fresh redactor.
    again = Redactor().redact("Contact me at alice@example.com please.")
    assert again.findings[0].token == finding.token


def test_redactor_reverses_token() -> None:
    redactor = Redactor()
    result = redactor.redact("Phone: 555-123-4567")
    assert result.findings
    token = result.findings[0].token
    assert redactor.reverse(token) == "555-123-4567"


def test_redactor_handles_multiple_kinds() -> None:
    redactor = Redactor()
    result = redactor.redact(
        "Email alice@example.com or call 555-123-4567. SSN: 123-45-6789. IP 10.0.0.1."
    )
    kinds = {f.kind for f in result.findings}
    assert kinds == {PiiKind.email, PiiKind.phone_us, PiiKind.ssn_us, PiiKind.ipv4}
    # No PII survives in the redacted output.
    assert "alice@example.com" not in result.text
    assert "123-45-6789" not in result.text
    assert "555-123-4567" not in result.text
    assert "10.0.0.1" not in result.text


def test_redactor_skips_overlapping_matches() -> None:
    # SSN has higher pattern priority than phone; "123-45-6789" must redact as
    # SSN and not be double-counted as phone-ish too.
    redactor = Redactor()
    result = redactor.redact("SSN 123-45-6789 only.")
    assert len(result.findings) == 1
    assert result.findings[0].kind is PiiKind.ssn_us


def test_redactor_returns_empty_for_clean_text() -> None:
    redactor = Redactor()
    out = redactor.redact("This is a clean sentence about mathematics.")
    assert out.findings == []
    assert out.text == "This is a clean sentence about mathematics."
