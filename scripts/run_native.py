#!/usr/bin/env python3
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
launcher = root / 'dist/still-linux-x64/still'
if not launcher.exists():
    subprocess.run([sys.executable, str(root / 'scripts/build_native.py')], check=True)
os.execv(launcher, [str(launcher), *sys.argv[1:]])
