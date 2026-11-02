#!/usr/bin/env python3
"""Run the real checker against isolated fontconfig/dpkg command stubs."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

checker = Path(__file__).with_name("check-caption-fonts.py")
with tempfile.TemporaryDirectory(prefix="riflo-font-check-") as temporary:
    root = Path(temporary)
    manifest = root / "manifest.tsv"
    manifest.write_text("fonts-noto-cjk\t1\nfonts-noto-core\t2\n")
    stub = root / "stub"
    stub.write_text('''#!/usr/bin/env python3
import os, sys
name = os.path.basename(sys.argv[0])
mode = os.environ.get("FONT_TEST_MODE", "")
if name == "dpkg-query":
    print("fonts-noto-cjk\\t1\\nfonts-noto-core\\t" + ("3" if mode == "drift" else "2"))
elif name == "fc-list":
    print("" if mode == "missing" else "Noto Sans")
elif "%{charset}" in sys.argv:
    print("0-7f" if mode == "resolved_missing" else "0-10ffff")
elif "charset=4e2d" in sys.argv[-1]:
    print("Wrong CJK|Bold" if mode == "cjk" else "Noto Sans CJK JP|Bold")
else:
    print("Wrong Primary|Bold" if mode == "primary" else "Noto Sans|Bold")
''')
    stub.chmod(0o755)
    for name in ("fc-list", "fc-match", "dpkg-query"):
        (root / name).symlink_to(stub)
    for mode, expected in (("", None), ("drift", "package drift"), ("missing", "Missing caption glyphs"),
                           ("resolved_missing", "Resolved font lacks"), ("primary", "Unexpected primary"),
                           ("cjk", "Expected default CJK"), ("manifest", "Missing accepted")):
        result = subprocess.run([sys.executable, str(checker), str(root / "absent" if mode == "manifest" else manifest)],
                                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"], "FONT_TEST_MODE": mode},
                                capture_output=True, text=True)
        assert (result.returncode == 0) == (expected is None), (mode, result.stderr)
        if expected:
            assert expected in result.stderr, (mode, result.stderr)
print("Caption font checker checks passed.")
