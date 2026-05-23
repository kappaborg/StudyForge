# sandbox-runner

Ephemeral, network-disabled, resource-capped executor for uploaded code (`.py`, `.ipynb`).

**Implementation target:** Phase 5 hardening (Wk 14–15).

## Design

- Runtime: gVisor or Firecracker microVM
- Limits: 256 MB RAM, 30 s CPU, read-only FS except `/tmp`, syscall allowlist
- Network: disabled (no egress, no DNS)
- Lifecycle: spun up on demand by `ai-worker`, torn down after each invocation
- Communication: gRPC over UDS, request/response carries source + stdin, returns stdout/stderr + exit code + resource usage

## Tasks (open)

- [ ] gVisor runtime selection vs Firecracker (ADR-0003)
- [ ] gRPC schema for invocation
- [ ] Resource enforcement integration test
