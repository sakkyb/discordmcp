#!/usr/bin/env python3
"""Report how many displays macOS currently has active.

Zero displays is the signature of the WhatsApp send failure: with no display,
no application can become frontmost, so the composer check can never pass.
The Mac Mini is headless and only has a display while a remote session or a
virtual screen provides one.

Must run under /usr/local/bin/python3 — /usr/bin/python3 has no pyobjc.
Prints: displays=<n> geometry=<WxH,WxH|none>
"""
import sys

try:
    import Quartz
except ImportError:
    print("displays=unknown geometry=none")
    sys.exit(1)

err, ids, count = Quartz.CGGetActiveDisplayList(16, None, None)
if err != 0:
    print("displays=unknown geometry=none")
    sys.exit(1)

geometry = ",".join(
    f"{Quartz.CGDisplayPixelsWide(d)}x{Quartz.CGDisplayPixelsHigh(d)}"
    for d in list(ids or [])[:count]
)
print(f"displays={count} geometry={geometry or 'none'}")
