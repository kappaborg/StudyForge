"""S3 object fetcher used by the ingest agent.

Talks to MinIO in dev (via path-style addressing) and to real S3 in prod via
the same boto3 client. Reading is a single GetObject — we don't stream because
PyMuPDF needs the full document in memory anyway.
"""

from __future__ import annotations

from dataclasses import dataclass

import boto3
from botocore.client import Config


@dataclass
class S3Config:
    endpoint_url: str
    region: str
    access_key: str
    secret_key: str
    bucket: str
    force_path_style: bool = True


def build_s3_client(cfg: S3Config) -> object:
    return boto3.client(
        "s3",
        endpoint_url=cfg.endpoint_url,
        region_name=cfg.region,
        aws_access_key_id=cfg.access_key,
        aws_secret_access_key=cfg.secret_key,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path" if cfg.force_path_style else "auto"},
        ),
    )


def fetch_bytes(client: object, *, bucket: str, key: str) -> bytes:
    response = client.get_object(Bucket=bucket, Key=key)  # type: ignore[attr-defined]
    data: bytes = response["Body"].read()
    return data
