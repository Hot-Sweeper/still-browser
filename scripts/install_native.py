#!/usr/bin/env python3
"""Install the tested native build and preserve the original launcher for rollback."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess

from migrate_profile import prepare_migration

ROOT = Path(__file__).resolve().parents[1]


def main():
    os.umask(0o077)
    bundle = ROOT / 'dist' / 'still-linux-x64'
    if not (bundle / 'runtime' / 'firefox').exists():
        raise SystemExit('Build Still first: npm run pack')
    local = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share'))
    config = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config'))
    install = Path.home() / '.local/opt/still-browser'
    install.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    backups = install / 'backups' / stamp
    backups.mkdir(parents=True)
    temporary = install / f'.native-install-{os.getpid()}'
    if temporary.exists():
        shutil.rmtree(temporary)
    shutil.copytree(bundle, temporary)
    destination = install / 'native'
    if destination.exists():
        destination.rename(backups / 'native')
    temporary.rename(destination)
    desktop_dirs = {local / 'applications'}
    result = subprocess.run(['xdg-user-dir', 'DESKTOP'], capture_output=True, text=True, check=False)
    if result.returncode == 0 and result.stdout.strip():
        desktop_dirs.add(Path(result.stdout.strip()))
    for candidate in [Path.home() / 'Desktop', Path.home() / 'Schreibtisch']:
        if (candidate / 'Still.desktop').exists():
            desktop_dirs.add(candidate)
    icon = local / 'icons/hicolor/1024x1024/apps/still.png'
    icon.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / 'build/icon.png', icon)
    desktop = f'''[Desktop Entry]
Name=Still
Comment=A calm native browser with five fixed slots and fluid transitions
Exec="{destination / 'still'}" %U
Terminal=false
Type=Application
Icon={icon}
StartupWMClass=com.tim.still
MimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;
Categories=Network;WebBrowser;
StartupNotify=true
'''
    for directory in desktop_dirs:
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / ('com.tim.still.desktop' if directory == local / 'applications' else 'Still.desktop')
        if path.exists():
            shutil.copy2(path, backups / (directory.name + '-' + path.name))
        path.write_text(desktop)
        path.chmod(0o755 if path.name == 'Still.desktop' else 0o644)
    migration = prepare_migration(config / 'Still', config / 'Still Native')
    (backups / 'installation.json').write_text(json.dumps({'source':str(ROOT),'installed':str(destination),'migration':migration}, indent=2))
    subprocess.run(['update-desktop-database', str(local / 'applications')], check=False)
    print(f'Installed native Still: {destination}')
    print(f'Previous launchers preserved: {backups}')
    print(f'Migrated browsing state: {migration}')


if __name__ == '__main__':
    main()
