# ADR-0003 — Sandbox runtime: gVisor over Firecracker

**Status:** Accepted
**Date:** 2026-06-13
**Owner:** Platform
**Implements:** Phase 5 §8 of [`prompt.md`](../../prompt.md) — "Zero
uploaded code executes outside the sandbox."

## Context

The `apps/sandbox-runner` service runs student-supplied code. The
in-process executor (Phase 5a) caps wall-clock time, peak memory,
CPU seconds, and stdout/err bytes — but those are CPython-level
controls. A real attack surface (syscall abuse, kernel exploits,
network exfiltration, container escape) needs a *runtime-level*
sandbox between the executor and the host kernel.

The two production-grade options:

| | gVisor (`runsc`) | Firecracker microVM |
| --- | --- | --- |
| Isolation primitive | User-space syscall interceptor | KVM hypervisor; full guest kernel |
| Cold start | ~50 ms | ~125 ms |
| Per-instance memory overhead | ~15 MB | ~5 MB |
| Filesystem | Bind mounts via Sentry filtering | Block device via virtio |
| Network | None (default) or NAT'd through host | TAP + virtio-net |
| Docker integration | `--runtime=runsc` drop-in | Requires Ignite or Weaveworks Footloose orchestrator |
| Linux kernel CVE blast radius | Limited (Sentry re-implements ~70% of syscalls) | None — the guest kernel is the boundary |
| Free-tier hosting | Render, Fly, GCP Cloud Run gen2, AWS App Runner | AWS Lambda (limited), Fly Machines |
| Maturity at our scale | Battle-tested (Google Cloud Run uses it for every request) | Battle-tested (AWS Lambda uses it for every invocation) |

## Decision

We adopt **gVisor (`runsc`)** as the sandbox runtime.

## Rationale

1. **Docker drop-in beats orchestrator surgery.** Selecting Firecracker
   requires running an entire microVM orchestration layer (Ignite,
   Footloose, or a custom Firecracker invoker). Our deployment surface
   is "set `--runtime=runsc` on the container" — same Dockerfile, same
   Render/Fly/k8s manifest. Onboarding cost is hours, not weeks.

2. **The performance trade-off lands on the right side for us.** gVisor's
   ~50 ms cold start matters because every student `/v1/execute` call
   spins a fresh process. Firecracker's 125 ms triples that latency.
   The per-instance memory overhead is the inverse direction — gVisor
   pays 15 MB to Firecracker's 5 MB — but at our concurrency cap of 6
   in-flight executions (the executor's thread-pool size) the
   difference is 60 MB, well under the 256 MB cap a single execution
   already takes.

3. **Kernel-CVE risk is acceptable at our risk profile.** Firecracker's
   ironclad isolation only matters if a Sentry-implemented syscall has
   a CVE that gVisor specifically exposes. Google Cloud Run has run
   every customer request through `runsc` since 2019; the public CVE
   stream is small and patched in days. For untrusted student code on a
   single-tenant Postgres + S3 stack (no shared compute with other
   customers), this is the right calibration.

4. **Network egress is denied by default**, which is exactly what we
   want for "students run untrusted code." Firecracker can do the same,
   but only by configuring the TAP device to drop all routes — that's a
   separate config layer where gVisor's default is correct.

## Consequences

- `apps/sandbox-runner/Dockerfile` ships unchanged whether the runtime
  is `runsc` or the default `runc`. The deploy layer picks the runtime
  hint:
    - **Render:** Add `runtimeClassName: gvisor` to the service YAML
      once Render exposes the `runc-gvisor` runtime option (currently
      in beta).
    - **Fly:** Use the `--vm-runtime=runsc` flag on `fly deploy`.
    - **k8s:** Define a `RuntimeClass` resource pointing at `runsc`
      and reference it in the pod spec.
    - **Local Docker:** Install gVisor (`apt install runsc` on
      Debian) and pass `--runtime=runsc` to `docker run`.
- The `runc` fallback (no `runsc` available) is acceptable for **dev**
  and **CI**, not for production. CI does not currently fail when
  `runsc` is absent — the executor's process-level caps are
  exercised regardless.
- Phase 5c's fuzz suite explicitly does NOT cover runtime-layer
  controls (network namespace, syscall allowlist) because the
  surrounding runtime determines them. A future commit adds runtime-
  conditional fuzz that asserts e.g. `socket.connect` fails when
  `runsc` is the active runtime.

## Alternatives rejected

- **Firecracker** — see §3 of the rationale.
- **Native Linux namespaces + seccomp filters** — equivalent to
  rolling our own gVisor. The CVE-patch burden is on us instead of on
  Google's team. Not a credible alternative at our maturity.
- **Run untrusted code without a runtime sandbox** — explicitly
  rejected by §8 of `prompt.md`. The in-process caps are necessary but
  not sufficient.
