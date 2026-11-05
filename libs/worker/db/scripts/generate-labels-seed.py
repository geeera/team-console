#!/usr/bin/env python3
"""The label seed of the console's tracker (#410), produced by the vendored product-team plugin itself.

Run from the repository root after every `vendor` update of `.claude/product-team`:

    python3 libs/worker/db/scripts/generate-labels-seed.py

src/lib/tracker/labels-seed.json — `ptlib.labels.LABELS` in the plugin's order as `[name, color, description]` rows, with the plugin
              version and a SHA-256 of `labels.py`. `LABELS_SEED` is read from it; `labels-seed.spec.ts` fails
              until it matches the vendored file again (the pattern of libs/shared/owner-grammar/fixtures).
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[4]
PLUGIN = ROOT / ".claude" / "product-team"
SOURCE = "scripts/ptlib/labels.py"
OUT = Path(__file__).resolve().parents[1] / "src" / "lib" / "tracker" / "labels-seed.json"

sys.path.insert(0, str(PLUGIN / "scripts"))
from ptlib import labels  # noqa: E402


def main():
    manifest = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    digest = hashlib.sha256((PLUGIN / SOURCE).read_bytes()).hexdigest()
    rows = [[name, color, description] for name, (color, description) in labels.LABELS.items()]
    # One label per line, ASCII-only escapes: a vendor update shows up as a readable diff.
    lines = ",\n".join("  " + json.dumps(row, ensure_ascii=True) for row in rows)
    header = json.dumps({"version": manifest["version"], "sources": {SOURCE: digest}}, ensure_ascii=True)
    OUT.write_text(f'{{\n "plugin": {header},\n "labels": [\n{lines}\n ]\n}}\n', encoding="utf-8")
    print(f"plugin {manifest['version']}: {len(rows)} labels written to {OUT.name}", file=sys.stderr)


if __name__ == "__main__":
    main()
