# ADR-0001: Record architecture decisions

## Status

Accepted (2026-05-21).

## Context

StudyForge AI integrates a Node gateway, a Python AI worker fleet, multi-provider LLM routing, sandboxed code execution, and strict compliance posture. Decisions ripple across teams and outlive any individual contributor. Without a durable record, we re-litigate the same trade-offs.

## Decision

Every architecturally significant decision is captured as an ADR in `docs/adr/` using the format below. ADRs are numbered, immutable once accepted, and superseded by explicit follow-ups (never edited).

### Template

```
# ADR-NNNN: <decision>
## Status
Proposed | Accepted | Superseded by ADR-XXXX
## Context
…
## Decision
…
## Consequences
…
```

### What qualifies

- Choice of a foundational runtime, store, or framework
- Tenancy / isolation model
- Cross-service contracts (events, queue topology)
- Security posture and threat-model boundaries
- Anything that would surprise a senior engineer joining six months from now

### What does not

- Library upgrades within a major version
- Internal refactors with no external behaviour change
- Naming / formatting

## Consequences

Adding an ADR is a required gate for PRs that change anything in the "qualifies" list. Reviewers may demand an ADR before approving the implementation.
