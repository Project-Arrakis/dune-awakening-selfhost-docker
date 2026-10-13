"""Build-locked Tank-only module-ID compatibility, with native non-Tank paths.

The three historical ID-zeroing sites operate on a module record whose first
field is an FName. Resolve its comparison name using the exact matching build's
FName pool layout, as used by native FName::ToString at 0x1002e860. Only ASCII
Tank-prefixed module names retain the original compatibility path. No engine
function is called, no mutable lookup cache is added, and scratch registers and
incoming flags are restored before executing either original instruction path.
"""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import tempfile

CLEAN_SHA = '91a3cfb069dd44c67354c88b8d9a1cf1f1300dd971b462b9f8feba6da8a46150'
POOL = 0x174135c0
POOL_READY = 0x17413591
CAVE = 0x14ad1819  # 231 bytes after SEED_ofb128_encrypt's ret
DECODER = 0x1002e8a4
DECODER_BYTES = '4489f0c1e810488d0d0f4d3e07488b44c168410fb7ce0fb73c48'
SITES = (
    (0xf9fbbe0, '4d8b4c24e8', '4531c99090', 'mov r10d, [r12 - 8]'),
    (0xfd56b5e, '488b8568ffffff', '31c09090909090', 'mov r10d, [r12]'),
    (0xfd5c3d4, '488b4008488945b8', '31c09090488945b8', 'mov r10, r13'),
)
BASE_SITES = (
    (234071954, '488d3de792ffffe892e50302', '909090909090909090909090'),
    (262200800, '0f8512010000', '90e912010000'),
    (265643297, '0f849d010000', 'e99e01000090'),
)


def assembly():
    helper = '''
.intel_syntax noprefix
.section .text,"ax",@progbits
.global tank_name
tank_name:
    push rax
    push rcx
    push rdx
    cmp byte ptr [rip + name_pool_ready], 0
    je not_tank
    mov ecx, r10d
    mov eax, ecx
    shr eax, 16
    cmp eax, 8192
    jae not_tank
    lea rdx, [rip + name_pool]
    mov rdx, [rdx + rax*8 + 0x68]
    test rdx, rdx
    je not_tank
    movzx ecx, cx
    lea rdx, [rdx + rcx*2]
    test byte ptr [rdx], 1
    jne not_tank
    cmp word ptr [rdx], 256
    jb not_tank
    mov eax, [rdx + 2]
    or eax, 0x20202020
    cmp eax, 0x6b6e6174
    jmp name_done
not_tank:
    or eax, 1
name_done:
    pop rdx
    pop rcx
    pop rax
    ret
'''
    handlers = []
    for index, (_, before, tank, name) in enumerate(SITES):
        handlers.append(f'''
.section .text,"ax",@progbits
.global site_{index}
site_{index}:
    pushfq
    push r10
    {name}
    call tank_name
    jne native_{index}
    pop r10
    popfq
    .byte {','.join('0x'+tank[p:p+2] for p in range(0,len(tank),2))}
    jmp return_{index}
native_{index}:
    pop r10
    popfq
    .byte {','.join('0x'+before[p:p+2] for p in range(0,len(before),2))}
    jmp return_{index}
''')
    return helper + ''.join(handlers) + '\n.section .note.GNU-stack,"",@progbits\n'


def compile_payload(directory):
    source = directory / 'scoped.S'
    source.write_text(assembly())
    obj, elf = directory / 'scoped.o', directory / 'scoped.elf'
    subprocess.run(['as', '--64', '-o', str(obj), str(source)], check=True)
    linker = directory / 'scoped.ld'
    script = f'''SECTIONS {{
      .text {CAVE:#x} : {{ *(.text) }}
      /DISCARD/ : {{ *(.note.GNU-stack) }}
    }}
    name_pool = {POOL:#x}; name_pool_ready = {POOL_READY:#x};
    '''
    for i, (offset, before, _, _) in enumerate(SITES):
        script += f'return_{i} = {offset + len(bytes.fromhex(before)):#x};\n'
    linker.write_text(script)
    subprocess.run(['ld', '-T', str(linker), '-o', str(elf), str(obj), '-e', 'tank_name'], check=True)
    symbols = {}
    for line in subprocess.check_output(['nm', str(elf)], text=True).splitlines():
        fields = line.split()
        if len(fields) == 3:
            symbols[fields[2]] = int(fields[0], 16)
    payloads = []
    for section, address, size in (('.text', CAVE, 231),):
        output = directory / (section + '.bin')
        subprocess.run(['objcopy', '-O', 'binary', '--only-section='+section, str(elf), str(output)], check=True)
        payload = output.read_bytes()
        if not payload or len(payload) > size:
            raise ValueError('Scoped Tank instructions exceed reviewed executable padding.')
        payloads.append((address, payload))
    return symbols, payloads


def build(source, release_spec):
    if hashlib.sha256(source).hexdigest() != CLEAN_SHA:
        raise ValueError('Scoped Tank patch requires the exact reviewed clean build.')
    # Verify the native name-pool decoder against the reviewed disassembly.
    if source[DECODER:DECODER+len(bytes.fromhex(DECODER_BYTES))].hex() != DECODER_BYTES:
        raise ValueError('Native FName pool layout does not match the reviewed build.')
    # Never inherit an unreviewed site or an older generated code payload.
    patches = [list(site) for site in BASE_SITES]
    with tempfile.TemporaryDirectory(prefix='dune-tank-scope-') as temp:
        symbols, payloads = compile_payload(Path(temp))
    for i, (offset, before, _, _) in enumerate(SITES):
        length = len(bytes.fromhex(before))
        if source[offset:offset+length].hex() != before:
            raise ValueError('Module-ID site differs from the reviewed build.')
        jump = b'\xe9' + struct.pack('<i', symbols[f'site_{i}'] - offset - 5)
        patches.append([offset, before, (jump + b'\x90'*(length-5)).hex()])
    for address, payload in payloads:
        if source[address-1] != 0xc3 or source[address:address+len(payload)] != b'\xcc'*len(payload):
            raise ValueError('Reviewed code padding differs from the exact build.')
        patches.append([address, source[address:address+len(payload)].hex(), payload.hex()])
    result = bytearray(source)
    for offset, before, after in patches:
        if result[offset:offset+len(bytes.fromhex(before))].hex() != before:
            raise ValueError('Patch byte guard failed.')
        result[offset:offset+len(bytes.fromhex(before))] = bytes.fromhex(after)
    return bytes(result), {**release_spec, 'version': 'r6.4-tank-only-ids-candidate',
        'sites': patches, 'patchedSha256': hashlib.sha256(result).hexdigest(),
        'candidateOnly': True, 'gameplayVerified': False}


if __name__ == '__main__':
    import sys
    workspace = Path(sys.argv[1]).resolve()
    spec = json.loads((Path(__file__).resolve().parents[1] / 'manifest.json').read_text())
    binary, spec = build((workspace / 'server-2141883-clean').read_bytes(), spec)
    (workspace / 'DuneSandboxServer-Linux-Shipping.2141883-scoped-candidate').write_bytes(binary)
    (workspace / 'scoped-binary-manifest.json').write_text(json.dumps(spec, indent=2)+'\n')
    print(spec['patchedSha256'])
