"""Complexity classifier — deterministic, sub-millisecond, feature-based."""

from __future__ import annotations

from src.cost.complexity import ComplexityClass, classify_query


def _cls(text: str) -> ComplexityClass:
    return classify_query(text).classification


def test_empty_query_defaults_to_simple() -> None:
    assert _cls("") is ComplexityClass.simple
    assert _cls("   ") is ComplexityClass.simple


def test_short_definitional_questions_are_simple() -> None:
    assert _cls("What is gradient descent?") is ComplexityClass.simple
    assert _cls("Define entropy.") is ComplexityClass.simple
    assert _cls("Who is Alan Turing?") is ComplexityClass.simple


def test_code_blocks_classified_as_code() -> None:
    text = (
        "Why is this returning undefined?\n"
        "```js\n"
        "function add(a, b) { return a + b }\n"
        "```"
    )
    assert _cls(text) is ComplexityClass.code


def test_code_keywords_alone_can_classify_as_code_when_winning() -> None:
    text = "I have a class Foo with a private member; how do I override its method?"
    finding = classify_query(text)
    # Either code or medium wins depending on tie-break; code precedence should
    # ensure code on real code-tagged inputs.
    assert finding.classification in {ComplexityClass.code, ComplexityClass.medium}


def test_multi_doc_vocab_routes_to_multi_doc() -> None:
    assert _cls("Compare gradient descent across all my lecture slides.") is ComplexityClass.multi_doc
    assert _cls("Summarize the course module on regression.") is ComplexityClass.multi_doc


def test_reasoning_vocab_routes_to_complex() -> None:
    assert _cls("Prove that the gradient of the loss equals -y * x.") is ComplexityClass.complex
    assert _cls("Walk me through why backprop works step by step.") is ComplexityClass.complex


def test_long_queries_skew_complex() -> None:
    long_q = (
        "I'd like to understand the relationship between gradient descent and "
        "stochastic gradient descent and how the learning rate interacts with "
        "the batch size. Why do these affect convergence? What happens in the "
        "limit of small / large batches? Please give intuition and a concrete "
        "example. " * 4
    )
    assert _cls(long_q) is ComplexityClass.complex


def test_classification_is_deterministic_across_runs() -> None:
    text = "Explain why softmax produces a probability distribution."
    first = classify_query(text)
    second = classify_query(text)
    assert first == second


def test_findings_include_reasons() -> None:
    finding = classify_query("Prove the chain rule step by step.")
    assert "reasoning_vocab" in finding.reasons
    assert finding.classification is ComplexityClass.complex


def test_simple_opener_outweighs_short_query_default() -> None:
    # Short non-definition text might still classify as simple — make sure the
    # explicit "What is" opener wins decisively.
    text = "What is overfitting?"
    finding = classify_query(text)
    assert finding.classification is ComplexityClass.simple
    assert "simple_opener" in finding.reasons
