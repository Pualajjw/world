# -*- coding: utf-8 -*-
"""Index registered EXE/PBD files with the same reader and names as the PBD overlay."""
import contextlib
import json
import os
import sys


def main(request):
    from pypower import cli
    reader = cli._load_decompile_apl(required=True).PBLFastReader
    result = []
    for library, path in request['libraries']:
        try:
            if not os.path.isfile(path):
                continue
            names = []
            for entry in reader.get_compiled_object_entries_fast(path, forced_version=request['pcodeVersion'] or None):
                binary = entry['objname']
                stem, extension = os.path.splitext(binary)
                suffix = cli.COMPILED_OBJECT_SOURCE_EXTENSIONS.get(extension.lower())
                if suffix and stem and not any(c in binary for c in ('/', '\\', ':', '\0')):
                    names.append([stem + suffix, binary])
            result.append([library, names])
        except (ValueError, OSError, UnicodeError):
            continue  # Missing results go through the host's virtual directory fallback.
    return result


if __name__ == '__main__':
    with contextlib.redirect_stdout(sys.stderr):
        result = main(json.loads(sys.stdin.buffer.read().decode('utf-8')))
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))
