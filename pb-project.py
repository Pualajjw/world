# -*- coding: utf-8 -*-
"""Python 3.4 x86 worker. Run the saved PBT; build only from private library copies."""
import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile

@contextlib.contextmanager
def worker_temp(roots, report=None):
    """Keep a working system temp; otherwise use a private directory under a host-approved root."""
    try:
        tempfile.gettempdir()
    except OSError:
        pass
    else:
        if report:
            report('system')
        yield
        return
    for root in roots:
        try:
            scratch = tempfile.TemporaryDirectory(prefix='world-pb-', dir=root)
        except OSError:
            continue
        with scratch as directory:
            # Directory creation alone does not establish permission to write/delete files.
            try:
                with tempfile.TemporaryFile(dir=directory):
                    pass
            except OSError:
                continue
            keys = ('TMPDIR', 'TEMP', 'TMP')
            previous = [os.environ.get(key) for key in keys]
            saved = tempfile.tempdir
            try:
                tempfile.tempdir = directory
                for key in keys:
                    os.environ[key] = directory
                if report:
                    report('private')
                yield
            finally:
                tempfile.tempdir = saved
                for key, value in zip(keys, previous):
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
            return
    if report:
        report('unavailable')
    raise RuntimeError('没有可写的临时目录。请检查 TEMP/TMP 的写入权限、磁盘空间，或为当前会话配置可写的工作目录。')


def run_pb9_pbt(target):
    # DSH starts this worker with SW_HIDE. Load PBVM in a child with normal GUI
    # startup instead; CREATE_NO_WINDOW suppresses only the Python console.
    code = subprocess.call([sys.executable, '-I', '-B', '-u', __file__, 'run-windowed', target, '90'],
                           creationflags=0x08000000, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr)
    # Python 3.4 x86 sys.exit expects a signed C long, even for NTSTATUS codes.
    return code - 0x100000000 if code >= 0x80000000 else code


def build(target, version, directory, mode, icon, pbr):
    from pypower import cli
    info = cli.read_pbt(target)
    libs = cli.resolve_project_libraries(info)
    app = os.path.normcase(cli.resolve_applib(info))
    if app not in [os.path.normcase(path) for path in libs]:
        raise ValueError('Application library is not in the PBT library list: ' + app)
    names = [os.path.basename(path) for path in libs]
    if len(set(os.path.normcase(name) for name in names)) != len(names):
        raise ValueError('Cannot package conflicting library filenames into one directory.')
    if not app.endswith('.pbl') or any(not name.lower().endswith(('.pbl', '.pbd')) for name in names):
        raise ValueError('Build requires an application PBL. Restore the binary project first.')
    external = [mode == 'external' or name.lower().endswith('.pbd') for name in names]
    sidecars = [os.path.splitext(name)[0] + '.pbd' for name, flag in zip(names, external) if flag]
    if len(set(os.path.normcase(name) for name in sidecars)) != len(sidecars):
        raise ValueError('Conflicting output PBD filenames.')
    # ORCA rebuilds libraries and may delete sibling PBDs. Never point it at live libraries.
    with tempfile.TemporaryDirectory(dir=os.path.dirname(directory)) as stage:
        work = os.path.join(stage, 'work')
        out = os.path.join(stage, 'out')
        os.mkdir(work)
        os.mkdir(out)
        for path, name in zip(libs, names):
            shutil.copyfile(path, os.path.join(work, name))
        info.update(applib=os.path.basename(app), libraries=names)
        pbt = os.path.join(work, os.path.basename(target))
        with io.open(pbt, 'w', encoding='gbk') as stream:
            stream.write(cli.pbt_info_to_content(info))
        exe = os.path.join(out, os.path.splitext(os.path.basename(target))[0] + '.exe')
        args = ['build', 'exe', pbt, '--pb-version', version, '--out', exe, '--pbd', ','.join('1' if flag else '0' for flag in external)]
        if icon:
            args.extend(['--icon', icon])
        if pbr:
            args.extend(['--pbr', pbr])
        # Some ORCA link errors are printed as JSON with exit code zero.
        log = io.StringIO()
        with contextlib.redirect_stdout(log):
            code = cli.main(args)
        text = log.getvalue().strip()
        reported = text.splitlines()[-1] if text else ''
        if (code or not os.path.isfile(exe) or os.path.getsize(exe) == 0 or
                os.path.normcase(reported) != os.path.normcase(exe)):
            raise RuntimeError(text or 'ORCA produced no executable')
        for pbd in sidecars:
            shutil.move(os.path.join(work, pbd), os.path.join(out, pbd))
        # Same-volume rename publishes all artifacts together; Windows refuses existing destinations.
        if os.path.exists(directory):
            raise ValueError('Output directory already exists: ' + directory)
        os.rename(out, directory)
    return 0


def main(argv):
    roots = []
    while argv[:1] == ['--temp-root']:
        roots.append(argv[1])
        argv = argv[2:]
    action, target, version = argv[:3]
    def report(mode):
        print('WORLD_PB_TEMP:' + mode, file=sys.stderr, flush=True)
    with worker_temp(roots, None if action == 'run-windowed' else report):
        if action == 'run' and os.path.splitext(target)[1].lower() == '.pbt':
            if version == '90':
                return run_pb9_pbt(target)
            if version == '80':
                import runpy
                launcher = runpy.run_path(os.path.join(os.path.dirname(__file__), 'pb80-ide.py'))
                return launcher['run'](target, '--allow-local-run-files' in argv[3:])
        if action in ('run', 'run-windowed'):
            if version == '80':
                raise ValueError('PB8 运行必须走原生 IDE，不支持动作 ' + action + '：' + target)
            from pypower import cli
            return cli.main(['pbt', 'run', target, '--pb-version', version])
        return build(target, version, *argv[3:])


if __name__ == '__main__':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace', line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace', line_buffering=True)
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
