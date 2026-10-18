#!/usr/bin/env python3
"""Keep the native wizard's palette aligned with the extension's source tokens."""
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
css = (root / "extension/styles/theme.css").read_text()
swift = (root / "macos/Sources/SynkUI/Theme.swift").read_text()
colors = {"background": "background", "foreground": "foreground", "card": "card", "primary": "primary", "primaryForeground": "primary-foreground", "muted": "muted-foreground", "border": "border", "secondary": "secondary", "blue": "brand-blue", "navy": "brand-navy", "destructive": "destructive"}
for native, token in colors.items():
    source = re.search(r"--" + token + r": #([a-f0-9]{6});", css)
    target = re.search(r"\b" + native + r" = Color\(hex: 0x([a-f0-9]{6})\)", swift)
    if not source or not target or source[1] != target[1]:
        raise SystemExit(f"Native color {native} must match extension --{token}")
for name in ["Manrope.ttf", "IBMPlexMono-Regular.ttf", "Manrope-LICENSE.txt", "IBM-Plex-Mono-LICENSE.txt"]:
    if not (root / "macos/Resources" / name).is_file():
        raise SystemExit(f"Missing bundled font/license: {name}")
print("Native palette matches all 11 extension tokens; both font families and licenses are bundled.")
