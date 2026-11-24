# -*- coding: utf-8 -*-
"""Run with the same x86 Python 3.4 used by world. No PB application is started."""
import os
import runpy
import subprocess
import sys
import tempfile
# The bundled interpreter intentionally omits unittest/mock.
worker = runpy.run_path(os.path.join(os.path.dirname(__file__), '..', 'pb-project.py'))


def main():
    expected = tempfile.gettempdir()
    with worker['worker_temp']([]):
        assert expected == tempfile.gettempdir()
    with tempfile.TemporaryDirectory() as root:
        missing = os.path.join(root, 'missing')
        candidates, old = tempfile._candidate_tempdir_list, tempfile.tempdir
        try:
            tempfile.tempdir = None
            tempfile._candidate_tempdir_list = lambda: [missing]
            try:
                tempfile.gettempdir()
                raise AssertionError('temp failure not reproduced')
            except OSError:
                pass
            previous = [os.environ.get(key) for key in ('TMPDIR', 'TMP', 'TEMP')]
            with worker['worker_temp']([missing, root]):
                work = tempfile.gettempdir()
                assert os.path.dirname(work) == root
                from pypower import cli
                assert os.path.dirname(cli.DEFAULT_PBTEST_WORK_DIR) == work
                subprocess.check_call([sys.executable, '-I', '-B', '-c',
                    'import sys, tempfile, os; from pypower import cli; assert tempfile.gettempdir() == sys.argv[1]; assert os.path.dirname(cli.DEFAULT_PBTEST_WORK_DIR) == sys.argv[1]', work])
            assert not os.path.exists(work) and [os.environ.get(key) for key in ('TMPDIR', 'TMP', 'TEMP')] == previous
            try:
                with worker['worker_temp']([]):
                    raise AssertionError('unapproved workspace fallback')
            except RuntimeError as exc:
                assert 'TEMP/TMP' in str(exc)
        finally:
            tempfile.tempdir, tempfile._candidate_tempdir_list = old, candidates
    print('PB worker temp: system, fallback before import, child process, cleanup, denied roots passed')


if __name__ == '__main__':
    main()
