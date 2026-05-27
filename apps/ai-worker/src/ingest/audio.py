"""Audio → text via faster-whisper.

We transcribe with the ``tiny.en`` model: ~75 MB on disk, CPU-only, good
enough for lecture-style narration in English. The first call downloads
the weights into the user's HuggingFace cache; subsequent calls are
instant.

The model is loaded lazily and cached in a module-level slot — we don't
want to pay the load cost on worker boot when most uploads are PDFs.

Each Whisper segment becomes one ``Block`` so the existing chunker can
re-window them into chunks of the right size. We embed the start time
(in seconds) in ``Block.meta['timestamp']`` so a future "jump to N:NN"
UI can resolve back to the original audio.
"""

from __future__ import annotations

import logging
import os
import tempfile
from typing import Any

from ..agents.contracts import Block, ChunkModality

log = logging.getLogger(__name__)

_AUDIO_MIMES = {
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "audio/webm",
    "audio/ogg",
    "audio/x-m4a",
    "audio/mp4",
    "audio/aac",
    "audio/flac",
}
_AUDIO_EXTS = (".mp3", ".wav", ".m4a", ".webm", ".ogg", ".aac", ".flac")


def is_audio(mime: str, filename: str) -> bool:
    if mime in _AUDIO_MIMES:
        return True
    lower = filename.lower()
    return any(lower.endswith(ext) for ext in _AUDIO_EXTS)


_model: Any | None = None
_model_size = os.environ.get("WHISPER_MODEL", "tiny.en")


def _load_model() -> Any:
    """Lazy-loads the faster-whisper model. The import is also lazy so we
    don't pull ctranslate2 / onnxruntime into the worker boot path until
    the first audio file actually arrives."""
    global _model
    if _model is not None:
        return _model
    from faster_whisper import WhisperModel

    # ``cpu`` is the only universally available device; in a GPU deploy
    # the operator can set WHISPER_DEVICE=cuda. Compute-type defaults to
    # int8 which is ~2x faster than float32 with negligible quality loss
    # on speech.
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("WHISPER_COMPUTE", "int8")
    log.info(
        "audio.model_load model=%s device=%s compute_type=%s",
        _model_size,
        device,
        compute_type,
    )
    _model = WhisperModel(_model_size, device=device, compute_type=compute_type)
    return _model


def parse_audio(audio_bytes: bytes, *, filename: str = "audio") -> list[Block]:
    """Transcribe a single audio file and return its segments as Blocks.

    The Whisper API wants a path or file-like object, not bytes — easier
    to spool to a tempfile than to wrestle with seekable wrappers.
    """
    if not audio_bytes:
        return []
    model = _load_model()

    suffix = ""
    lower = filename.lower()
    for ext in _AUDIO_EXTS:
        if lower.endswith(ext):
            suffix = ext
            break

    # ``delete=False`` so the file handle releases before we hand the
    # path to faster-whisper; cleanup happens in the finally clause.
    tmp = tempfile.NamedTemporaryFile(suffix=suffix or ".audio", delete=False)
    try:
        tmp.write(audio_bytes)
        tmp.flush()
        tmp.close()

        # ``vad_filter=True`` drops long silent stretches (lecture pauses,
        # leading dead air), which materially improves transcript quality
        # on classroom recordings.
        segments_iter, info = model.transcribe(
            tmp.name,
            vad_filter=True,
            beam_size=1,
            condition_on_previous_text=False,
        )
        log.info(
            "audio.transcribed filename=%s duration=%.1fs language=%s",
            filename,
            info.duration,
            info.language,
        )

        blocks: list[Block] = []
        cursor = 0
        for segment in segments_iter:
            text = (segment.text or "").strip()
            if not text:
                continue
            char_start = cursor
            char_end = cursor + len(text)
            cursor = char_end + 1  # +1 for the implicit join newline
            blocks.append(
                Block(
                    modality=ChunkModality.text,
                    text=text,
                    char_start=char_start,
                    char_end=char_end,
                    meta={
                        "source": "audio",
                        "timestamp_s": round(segment.start, 2),
                        "duration_s": round(segment.end - segment.start, 2),
                    },
                )
            )
        return blocks
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


__all__ = ["is_audio", "parse_audio"]
