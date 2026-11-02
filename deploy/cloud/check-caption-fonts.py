#!/usr/bin/env python3
"""Linux service-user coverage and resolved-font gate; raster shaping is checked separately."""
import json
from pathlib import Path
import subprocess
import sys


def output(*command):
    return subprocess.run(command, check=True, capture_output=True, text=True).stdout.strip()


packages = output("dpkg-query", "-W", "-f=${Package}\t${Version}\n", "fonts-noto-core", "fonts-noto-cjk")
manifest = Path(sys.argv[1]) if len(sys.argv) == 2 else Path("/etc/riflo/caption-font-packages.tsv")
if not manifest.is_file():
    sys.exit("Missing accepted caption font manifest: " + str(manifest))
if manifest.read_text().strip() != packages:
    sys.exit("Caption font package drift; review runtime maintenance and accepted manifest.")

fixtures = json.loads(Path(__file__).with_name("caption-font-fixtures.json").read_text())
missing = []
resolved = {}
for character in sorted(set("".join(fixtures.values())) - {" "}):
    pattern = f"Noto Sans:style=Bold:charset={ord(character):x}"
    # fc-match can return an unrelated fallback even when no glyph is installed.
    if not output("fc-list", f":charset={ord(character):x}", "family"):
        missing.append(f"{character} (U+{ord(character):04X})")
    charset = output("fc-match", "-f", "%{charset}", pattern).split()
    ranges = [item.split("-") for item in charset]
    if not any(int(bounds[0], 16) <= ord(character) <= int(bounds[-1], 16) for bounds in ranges):
        missing.append(f"Resolved font lacks {character} (U+{ord(character):04X})")
    resolved[f"U+{ord(character):04X}"] = output("fc-match", "-f", "%{family}|%{style}", pattern)
if missing:
    sys.exit("Missing caption glyphs: " + ", ".join(missing))
primary = output("fc-match", "-f", "%{family}|%{style}", "Noto Sans:style=Bold")
if primary != "Noto Sans|Bold":
    sys.exit("Unexpected primary caption font: " + primary)
if "Noto Sans CJK JP" not in resolved["U+4E2D"]:
    sys.exit("Expected default CJK JP typography: " + resolved["U+4E2D"])
print(json.dumps({"packages": packages.splitlines(), "primary": primary, "resolved": resolved}, ensure_ascii=False, indent=2))
