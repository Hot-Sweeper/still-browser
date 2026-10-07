#!/usr/bin/env python3
"""Build Still's Linux native distribution from Mozilla's verified runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
METADATA = ROOT / 'native' / 'engine.json'


def download(url, target):
    if target.exists():
        return
    print(f'Downloading {target.name}', flush=True)
    with urllib.request.urlopen(url, timeout=90) as response:
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
            temporary = Path(output.name)
            try:
                shutil.copyfileobj(response, output)
                output.flush()
                os.fsync(output.fileno())
            except BaseException:
                temporary.unlink(missing_ok=True)
                raise
    temporary.replace(target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--update-engine', action='store_true')
    parser.add_argument('--archive', action='store_true')
    args = parser.parse_args()
    metadata = json.loads(METADATA.read_text())
    if args.update_engine:
        with urllib.request.urlopen('https://product-details.mozilla.org/1.0/firefox_versions.json', timeout=30) as response:
            metadata['version'] = json.load(response)['LATEST_FIREFOX_VERSION']
        metadata['source'] = f"https://archive.mozilla.org/pub/firefox/releases/{metadata['version']}/source/"
        METADATA.write_text(json.dumps(metadata, indent=2) + '\n')
    version = metadata['version']
    relative = f'linux-x86_64/en-US/firefox-{version}.tar.xz'
    base = f'https://archive.mozilla.org/pub/firefox/releases/{version}/'
    cache = ROOT / '.cache'
    cache.mkdir(exist_ok=True)
    archive = cache / f'firefox-{version}.tar.xz'
    checksums = cache / f'firefox-{version}-SHA512SUMS'
    download(base + relative, archive)
    download(base + 'SHA512SUMS', checksums)
    entries = dict((line.split()[1], line.split()[0]) for line in checksums.read_text().splitlines() if len(line.split()) == 2)
    with archive.open('rb') as stream:
        actual = hashlib.file_digest(stream, 'sha512').hexdigest()
    if entries.get(relative) != actual:
        raise SystemExit('Mozilla runtime checksum mismatch; refusing to build.')
    dist = ROOT / 'dist'
    dist.mkdir(exist_ok=True)
    subprocess.run(['node', str(ROOT / 'scripts' / 'fetch-yt-dlp.js')], check=True, cwd=ROOT)
    with tempfile.TemporaryDirectory(prefix='.still-build-', dir=dist) as work:
        work = Path(work)
        with tarfile.open(archive) as bundle:
            bundle.extractall(work, filter='data')
        runtime = work / 'firefox'
        ui = runtime / 'still'
        shutil.copytree(ROOT / 'native' / 'ui', ui)
        shutil.copy2(ROOT / 'build' / 'icon.png', ui / 'assets' / 'still-icon.png')
        shutil.copy2(ROOT / 'build' / 'vendor' / 'yt-dlp', ui / 'yt-dlp')
        shutil.copy2(ROOT / 'native' / 'runtime' / 'still.cfg', runtime / 'still.cfg')
        (runtime / 'defaults' / 'pref').mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'native' / 'runtime' / 'autoconfig.js', runtime / 'defaults' / 'pref' / 'still.js')
        distribution = work / 'still-linux-x64'
        distribution.mkdir()
        runtime.rename(distribution / 'runtime')
        shutil.copy2(ROOT / 'native' / 'launcher.py', distribution / 'still')
        (distribution / 'still').chmod(0o755)
        for name in ['LICENSE', 'README.md']:
            shutil.copy2(ROOT / name, distribution / name)
        shutil.copy2(METADATA, distribution / 'engine.json')
        output = dist / 'still-linux-x64'
        if output.exists():
            shutil.rmtree(output)
        distribution.rename(output)
    print(f'Built {output} (Firefox {version}, SHA512 verified)', flush=True)
    if args.archive:
        app_version = json.loads((ROOT / 'package.json').read_text())['version']
        target = dist / f'Still-{app_version}-linux-x64.tar.xz'
        with tarfile.open(target, 'w:xz', preset=3) as bundle:
            bundle.add(output, arcname='Still')
        print(f'Packaged {target}', flush=True)


if __name__ == '__main__':
    main()
