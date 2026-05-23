from celery import Celery

from .settings import get_settings

settings = get_settings()

celery_app = Celery(
    "studyforge",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        # task modules will be registered here as they are implemented
        # "src.tasks.ingest",
        # "src.tasks.embed",
        # "src.tasks.generate",
    ],
)

celery_app.conf.update(
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    task_default_queue="default",
    task_routes={
        "src.tasks.ingest.*": {"queue": "ingest"},
        "src.tasks.embed.*": {"queue": "embed"},
        "src.tasks.generate.*": {"queue": "generate"},
    },
    broker_connection_retry_on_startup=True,
)
