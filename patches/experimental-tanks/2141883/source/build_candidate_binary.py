"""Offline experimental candidate. Not a supported or gameplay-verified patch."""
import hashlib, json, sys
from pathlib import Path
from capstone import Cs, CS_ARCH_X86, CS_MODE_64

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).parent
old = json.loads((Path(__file__).resolve().parents[2] / '2134304/manifest.json').read_text())
mapped = json.loads((root/'binary-site-candidates.json').read_text())
source = (root/'server-2141883-clean').read_bytes()
clean_hash = '91a3cfb069dd44c67354c88b8d9a1cf1f1300dd971b462b9f8feba6da8a46150'
assert hashlib.sha256(source).hexdigest() == clean_hash
patched = bytearray(source)
md = Cs(CS_ARCH_X86, CS_MODE_64)
sites = []
for (old_offset, old_before, after), candidate in zip(old['sites'], mapped, strict=True):
    assert old_offset == candidate['old_offset'] and len(candidate['candidates']) == 1
    offset = candidate['candidates'][0]
    length = len(bytes.fromhex(old_before))
    before = source[offset:offset+length]
    assert len(bytes.fromhex(after)) == length
    instructions = list(md.disasm(before, offset))
    assert sum(i.size for i in instructions) == length
    assert candidate['new_context'][0]['address'] == offset
    if instructions[-1].mnemonic.startswith('j'):
        original_target = instructions[-1].op_str
        replacement = list(md.disasm(bytes.fromhex(after), offset))
        jump = next(i for i in replacement if i.mnemonic == 'jmp')
        assert jump.op_str == original_target
    patched[offset:offset+length] = bytes.fromhex(after)
    sites.append([offset,before.hex(),after])
target = root/'DuneSandboxServer-Linux-Shipping.2141883-candidate'
target.write_bytes(patched)
target.chmod(0o755)
report = {'candidateOnly':True,'version':'r6.0-candidate','worldTag':'2141883-0-shipping','baseImage':'registry.funcom.com/funcom/self-hosting/seabass-server@sha256:167c8bb1ef7137a43d086e022f02c965839c33277682c7cac78e7d68881335e5','baseConfigId':'sha256:df99c7800fb44624c20836783638651f85ed1824d67550bdebb19b66316ba213','cleanSha256':clean_hash,'patchedSha256':hashlib.sha256(patched).hexdigest(),'sites':sites,'gameplayVerified':False}
(root/'candidate-binary-manifest.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
