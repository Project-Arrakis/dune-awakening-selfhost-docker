"""Reproduce the guarded Tank-only module-ID candidate using GNU binutils."""
import json
import sys
from pathlib import Path
from scoped_module_ids import build

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).parent
spec = json.loads((Path(__file__).resolve().parents[1] / 'manifest.json').read_text())
patched, report = build((root / 'server-2141883-clean').read_bytes(), spec)
target = root / 'DuneSandboxServer-Linux-Shipping.2141883-scoped-candidate'
target.write_bytes(patched)
target.chmod(0o755)
(root / 'candidate-binary-manifest.json').write_text(json.dumps(report, indent=2)+'\n')
print(json.dumps(report, indent=2))
