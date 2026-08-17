#!/usr/bin/env python3
"""Read whatever is currently on screen, via Vision (on-device OCR).

    ocr-screen.py            -> prints recognised text, one region per " | "

Why this exists: WhatsApp's accessibility tree exposes UI *roles* but no text —
every value reads as "missing value". So when a send fails, AX can say focus was
on an "AXGroup" but not that the group is a blocking "Update WhatsApp" sheet, a
permission dialog, or the macOS login window. Vision reads all three directly.

Sibling of ocr-chat-header.py, which does the same thing to a 70px strip to
verify WHICH chat is open. That one is a safety check on the send path and only
runs after `prepare` succeeds — so it had never once seen a failure, since every
production failure died in `prepare`. This one is for the diagnostic path.

Free, on-device, no network, no API key, ~150-300ms warm. Must run under
/usr/local/bin/python3 — /usr/bin/python3 has no pyobjc.

Exit 0 with text, 0 with empty output if the screen is blank, 3 if the capture
itself failed (almost always the Screen Recording grant, which attaches to the
*responsible* process — launchd's node needs its own).
"""
import subprocess
import sys
import tempfile

import Quartz
import Vision
from Foundation import NSURL


def ocr(path: str) -> list[str]:
    src = Quartz.CGImageSourceCreateWithURL(NSURL.fileURLWithPath_(path), None)
    if src is None:
        return []
    cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(0)  # accurate
    req.setUsesLanguageCorrection_(False)
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
    handler.performRequests_error_([req], None)
    return [o.topCandidates_(1)[0].string() for o in (req.results() or [])]


def main() -> int:
    with tempfile.NamedTemporaryFile(suffix=".png", delete=True) as tmp:
        # -x silences the shutter sound; -o omits window shadows.
        r = subprocess.run(["screencapture", "-x", "-o", tmp.name], capture_output=True)
        if r.returncode != 0:
            print(f"CAPTUREFAIL {r.stderr.decode().strip() or 'screencapture failed'}", file=sys.stderr)
            return 3
        lines = ocr(tmp.name)
    # Bounded: this text ends up in a Discord alert with a 2000-char ceiling.
    print(" | ".join(lines)[:1200])
    return 0


if __name__ == "__main__":
    sys.exit(main())
