# -*- coding: utf-8 -*-
"""Run a saved PB8 target using its native IDE, without modifying the user's PBW or sending keystrokes."""
from contextlib import contextmanager, ExitStack
import ctypes as ct
from ctypes import wintypes as wt
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
import winreg


def find_ide():
    override = os.environ.get('WORLD_PB80_IDE')
    if override:
        if os.path.isabs(override) and os.path.basename(override).lower() == 'pb80.exe' and os.path.isfile(override):
            return override
        raise ValueError('WORLD_PB80_IDE 必须指向已安装的 pb80.exe 绝对路径。')
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, r'Software\Microsoft\Windows\CurrentVersion\App Paths\pb80.exe') as key:
                path = os.path.expandvars(winreg.QueryValueEx(key, '')[0]).strip('"')
            if os.path.isabs(path) and os.path.isfile(path):
                return path
        except OSError:
            pass
    raise RuntimeError('未找到 PowerBuilder 8 IDE。请设置 WORLD_PB80_IDE 为 pb80.exe 的绝对路径后重启 DSH。')


def read_pbt(path):
    """PB8 writes PBT in the machine ANSI codepage; a hand-edited file may already be UTF-8."""
    with open(path, 'rb') as stream:
        raw = stream.read()
    for encoding in ('utf-8-sig', 'mbcs', 'gbk'):
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            pass
    raise ValueError('PB8 PBT 编码无法识别（不是 UTF-8 / 系统 ANSI / GBK）：' + path)


def encode_pbt(text, path):
    # PB8 only reads ANSI. Refuse here instead of letting a bare UnicodeEncodeError escape.
    for encoding in ('mbcs', 'gbk'):
        try:
            return text.encode(encoding)
        except (UnicodeEncodeError, LookupError):
            pass
    raise ValueError('路径含当前系统 ANSI 代码页无法表示的字符，请把工程放到纯中文/英文路径：' + path)


def workspace(directory, target):
    # A unique title proves that the new IDE loaded this exact single-target workspace.
    name = 'WorldPB8_' + uuid.uuid4().hex[:12]
    path = os.path.join(directory, name + '.pbw')
    quoted = '"' + os.path.abspath(target).replace('\\', '\\\\') + '";'
    payload = 'Save Format v3.0(19990112)\n@begin Unchecked\n@end;\n@begin Targets\n 0 ' + quoted + '\n@end;\nDefaultTarget ' + quoted + '\n'
    with open(path, 'wb') as stream:
        stream.write(encode_pbt(payload, target))
    return name, path


@contextmanager
def run_target(target, allow_local_files):
    # Ctrl+R changes directory to the application library before application.open.
    # Only for split projects, place a private copy beside the PBT (never hard-link the original).
    directory = os.path.dirname(target)
    source = read_pbt(target)

    def field(key):
        match = re.search(r'(?im)^[ \t]*' + key + r'[ \t]+"([^"\r\n]*)"', source)
        if not match:
            raise ValueError('PB8 PBT 缺少 ' + key + '：' + target)
        return match

    def resolve(path):
        return os.path.abspath(os.path.join(directory, path.strip().replace('\\\\', '\\')))

    app = field('applib')
    library = resolve(app.group(1))
    # samefile raises FileNotFoundError on a missing path; report the wrong applib instead.
    host = os.path.dirname(library)
    if not os.path.isdir(host):
        raise ValueError('PB8 应用库所在目录不存在，请检查 PBT 的 applib：' + library)
    if not os.path.isfile(library):
        raise ValueError('PB8 应用库文件不存在，请检查 PBT 的 applib：' + library)
    if os.path.samefile(host, directory):
        yield target
        return
    if not allow_local_files:
        raise ValueError('PB8 运行需要在 PBT 目录创建临时文件，请将该目录加入会话可写范围：' + directory)
    suffix = os.path.splitext(library)[1].lower()
    if suffix not in ('.pbl', '.pbd'):
        raise ValueError('无效的 PB8 应用库：' + library)
    listing = field('LibList')
    entries = listing.group(1).split(';')
    indices = [i for i, entry in enumerate(entries) if os.path.normcase(resolve(entry)) == os.path.normcase(library)]
    if not indices:
        raise ValueError('PB8 应用 PBL 不在 LibList 中：' + library)
    with ExitStack() as cleanup:
        def temporary(suffix):
            f = tempfile.NamedTemporaryFile(prefix='WorldPB8_', suffix=suffix, dir=directory, delete=False)
            cleanup.callback(os.remove, f.name)
            return f

        with open(library, 'rb') as original, temporary(suffix) as copy:
            shutil.copyfileobj(original, copy)
        basename = os.path.basename(copy.name)
        for i in indices:
            entries[i] = basename
        # Keep every other target setting and relative reference intact, including library order.
        edits = [(app.span(1), basename), (listing.span(1), ';'.join(entries))]
        for (start, end), value in sorted(edits, reverse=True):
            source = source[:start] + value + source[end:]
        with temporary('.pbt') as shadow:
            shadow.write(encode_pbt(source, shadow.name))
        yield shadow.name


class IdeWindows:
    """Resolve an enabled native Run command, scoped strictly to the new PID's PBFRAME80."""
    def __init__(self, pid):
        self.pid = pid
        user = ct.WinDLL('user32', use_last_error=True)
        self.callback = ct.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
        def api(name, result, *args):
            fn = getattr(user, name)
            fn.restype, fn.argtypes = result, args
            return fn
        self.enum = api('EnumWindows', wt.BOOL, self.callback, wt.LPARAM)
        self.enum_children = api('EnumChildWindows', wt.BOOL, wt.HWND, self.callback, wt.LPARAM)
        self.owner = api('GetWindowThreadProcessId', wt.DWORD, wt.HWND, ct.POINTER(wt.DWORD))
        self.caption = api('GetWindowTextW', ct.c_int, wt.HWND, wt.LPWSTR, ct.c_int)
        self.klass = api('GetClassNameW', ct.c_int, wt.HWND, wt.LPWSTR, ct.c_int)
        self.enabled = api('IsWindowEnabled', wt.BOOL, wt.HWND)
        self.visible = api('IsWindowVisible', wt.BOOL, wt.HWND)
        self.menu = api('GetMenu', wt.HMENU, wt.HWND)
        self.submenu = api('GetSubMenu', wt.HMENU, wt.HMENU, ct.c_int)
        self.count = api('GetMenuItemCount', ct.c_int, wt.HMENU)
        self.item_id = api('GetMenuItemID', wt.UINT, wt.HMENU, ct.c_int)
        self.menu_text = api('GetMenuStringW', ct.c_int, wt.HMENU, wt.UINT, wt.LPWSTR, ct.c_int, wt.UINT)
        self.state = api('GetMenuState', wt.UINT, wt.HMENU, wt.UINT, wt.UINT)
        self.post = api('PostMessageW', wt.BOOL, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)
        self.send = api('SendMessageW', ct.c_ssize_t, wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM)

    def owned(self, hwnd):
        pid = wt.DWORD()
        self.owner(hwnd, ct.byref(pid))
        return pid.value == self.pid

    def windows(self, parent=None):
        rows = []
        @self.callback
        def visit(hwnd, unused):
            if self.owned(hwnd) and self.visible(hwnd):
                title, klass = ct.create_unicode_buffer(512), ct.create_unicode_buffer(128)
                self.caption(hwnd, title, len(title))
                self.klass(hwnd, klass, len(klass))
                rows.append((hwnd, klass.value, title.value))
            return True
        if parent:
            self.enum_children(parent, visit, 0)
        else:
            self.enum(visit, 0)
        return rows

    def run_command(self, hwnd):
        menu = self.menu(hwnd)
        for i in range(self.count(menu)):
            sub = self.submenu(menu, i)
            for j in range(self.count(sub)):
                label = ct.create_unicode_buffer(160)
                self.menu_text(sub, j, label, len(label), 0x400)  # MF_BYPOSITION
                # Distinguish Run from Run/Preview, Select and Run, and Debug.
                if label.value.replace(' ', '').lower().endswith('\tctrl+r') and not self.state(sub, j, 0x400) & 3:
                    command = self.item_id(sub, j)
                    if 0 < command < 0xffff:
                        return command
        return None

    def frame(self, process, name):
        until = time.monotonic() + 45
        dismissed = set()
        while time.monotonic() < until:
            if process.poll() is not None:
                raise RuntimeError('PB8 IDE 在打开工程前退出（退出码 %s）。' % process.returncode)
            for hwnd, klass, title in self.windows():
                if klass == 'PBFRAME80' and name.lower() in title.lower() and self.enabled(hwnd):
                    command = self.run_command(hwnd)
                    if command:
                        return hwnd, command
                if klass == '#32770' and title == 'PowerBuilder Enterprise' and hwnd not in dismissed:
                    rows = self.windows(hwnd)
                    # This portable PB8 shows a version splash with OK. Never acknowledge business dialogs.
                    if any(k == 'Static' and t.startswith('PowerBuilder Enterprise Version 8.') for _, k, t in rows):
                        for button, k, text in rows:
                            if k == 'Button' and text == 'OK':
                                self.post(button, 0xf5, 0, 0)  # BM_CLICK in our new IDE only
                                dismissed.add(hwnd)
                                break
            time.sleep(0.1)
        raise RuntimeError('PB8 IDE 未能打开目标或启用“运行 (Ctrl+R)”。请检查 IDE 安装和工程。')


def run(target, allow_local_files=False):
    ide = find_ide()
    target = os.path.abspath(target)
    cwd = os.path.dirname(target)
    with run_target(target, allow_local_files) as run_pbt, tempfile.TemporaryDirectory(prefix='world-pb8-') as directory:
        name, pbw = workspace(directory, run_pbt)
        # PB8 treats ~ as an escape on its command line (e.g. ADMINI~1).
        # The PBW contents and Win32 working directory use the literal paths.
        args = [ide, '/workspace', pbw.replace('~', '~~'), '/target', run_pbt.replace('~', '~~')]
        process = subprocess.Popen(args, cwd=cwd)
        try:
            ui = IdeWindows(process.pid)
            hwnd, command = ui.frame(process, name)
            if not ui.owned(hwnd):
                raise RuntimeError('PB8 IDE 窗口已关闭。')
            # Native Run is synchronous while the target owns the IDE. No global F5/Ctrl+R.
            ui.send(hwnd, 0x111, command, 0)  # WM_COMMAND
            # Some programs explicitly exit their host. Otherwise close only the unedited private IDE.
            if process.poll() is None and ui.owned(hwnd) and ui.enabled(hwnd):
                ui.post(hwnd, 0x10, 0, 0)  # WM_CLOSE, not a forced kill
            return process.wait()
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait()
