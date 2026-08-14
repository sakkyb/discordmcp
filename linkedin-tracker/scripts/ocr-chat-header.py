#!/usr/bin/env python3
"""Read the WhatsApp chat header by OCR and report whether it names the expected chat.

    ocr-chat-header.py <x> <y> <w> <h> <expected chat name>
    -> prints "MATCH <text>" or "NOMATCH <text>", exit 0 / 2

Why this exists: WhatsApp's accessibility tree exposes UI *roles* but no text —
every value reads as "missing value" — so a script can tell that a message
composer has focus but not WHICH chat it is about to type into. That gap is the
one way this automation could post to the wrong group, and it cannot be closed
through the accessibility API.

Vision (the on-device OCR behind Live Text) can read the header directly. No
network, no API key, no LLM; ~150-300ms warm.
"""
import re
import subprocess
import sys
import tempfile

import Quartz
import Vision
from Foundation import NSURL

HEADER_HEIGHT = 70  # the chat title sits in the top strip of the window


def normalise(s: str) -> str:
    # OCR is not character-exact — it reads "LinkedIn Maxxing" as "Linkedin
    # Maxxing". Compare on letters and digits only, case-insensitively; never ==.
    return re.sub(r"[^a-z0-9]", "", s.lower())


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
    if len(sys.argv) < 6:
        print("usage: ocr-chat-header.py <x> <y> <w> <h> <expected>", file=sys.stderr)
        return 1
    x, y, w, _h = (int(v) for v in sys.argv[1:5])
    expected = sys.argv[5]

    with tempfile.NamedTemporaryFile(suffix=".png", delete=True) as tmp:
        # -x silences the shutter sound; -R grabs just the header strip.
        r = subprocess.run(
            ["screencapture", "-x", "-o", "-R", f"{x},{y},{w},{HEADER_HEIGHT}", tmp.name],
            capture_output=True,
        )
        if r.returncode != 0:
            err = r.stderr.decode().strip() or "screencapture failed"
            # Almost always the Screen Recording permission, which — like
            # Accessibility and Automation — attaches to the *responsible*
            # process, so launchd's node needs its own grant.
            print(f"CAPTUREFAIL {err}", file=sys.stderr)
            return 3
        lines = ocr(tmp.name)

    text = " | ".join(lines)
    ok = normalise(expected) in normalise(" ".join(lines))
    print(f"{'MATCH' if ok else 'NOMATCH'} {text}")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
