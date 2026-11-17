"""Ovozni matnga aylantirish: python whisper_transcribe.py <audio.wav> <til: uz|ru|en>

Oxirgi qatorga JSON yozadi: {"text": "..."}.
Kerak: pip install faster-whisper (backend/.env: WHISPER_PYTHON, WHISPER_MODEL).
"""
import json
import os
import sys


def main() -> None:
    if len(sys.argv) < 3:
        print(json.dumps({"text": "", "error": "args"}))
        sys.exit(2)
    path, lang = sys.argv[1], sys.argv[2]

    from faster_whisper import WhisperModel  # noqa: E402

    import wave  # noqa: E402

    import numpy as np  # noqa: E402

    # Backend ovozni 16 kHz mono wav'ga ffmpeg bilan o'tkazib beradi. Uni o'zimiz o'qiymiz,
    # shunda faster-whisper'ning "av" kutubxonasi (versiya mos kelmasligi mumkin) kerak bo'lmaydi.
    with wave.open(path, "rb") as wf:
        raw = wf.readframes(wf.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    model_name = os.environ.get("WHISPER_MODEL", "small")
    threads = int(os.environ.get("WHISPER_THREADS", "0") or 0)
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=threads)
    segments, _info = model.transcribe(
        audio,
        language=lang or None,
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps({"text": text}, ensure_ascii=False))


if __name__ == "__main__":
    main()
