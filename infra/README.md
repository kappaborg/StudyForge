# infra

Infrastructure definitions, ordered by lifecycle.

| Directory | Purpose | Phase |
| --- | --- | --- |
| `docker/` | Shared Dockerfiles, base images, build helpers | 0 |
| `k8s/`    | Raw Kubernetes manifests for local clusters (kind/k3d) | 0–1 |
| `helm/`   | Production Helm charts (dev / staging / prod values) | 4 |
| `terraform/` | Cloud infra (VPC, RDS, ElastiCache, S3, KMS, IAM) | 4 |
| `grafana/`   | Dashboards-as-code: queue depth, token spend per tenant, RAG quality, Core Web Vitals | 1–5 |
| `velero/`    | Backup schedules + restore drills for K8s state | 4 |

See `docs/architecture/01-system-architecture.md` for the full topology.
