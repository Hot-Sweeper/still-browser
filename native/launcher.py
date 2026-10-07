#!/usr/bin/env python3
"""Still launcher: native browser, independent profile and remoting namespace."""
import os
from pathlib import Path
import sys


def main():
    os.umask(0o077)
    root = Path(__file__).resolve().parent
    runtime = root / 'runtime' / 'firefox'
    config = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config'))
    profile = Path(os.environ.get('STILL_PROFILE', config / 'Still Native')).resolve()
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(profile, 0o700)
    environment = os.environ.copy()
    environment['MOZ_APP_REMOTINGNAME'] = 'com.tim.still'
    environment['MOZ_ENABLE_WAYLAND'] = '1' if environment.get('WAYLAND_DISPLAY') else '0'
    # Native GPU compositing remains enabled. No sandbox-disabling flags.
    args = [str(runtime), '-profile', str(profile), '-name', 'Still', '-class', 'com.tim.still']
    args.extend(sys.argv[1:])
    os.execve(runtime, args, environment)


if __name__ == '__main__':
    main()
