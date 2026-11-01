#!/usr/bin/env python3
"""Create a new private Stash profile without modifying existing directory permissions."""
from pathlib import Path
import argparse
import getpass
import os
import stat
import sys

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PRIVATE = (Path.home() / '.config' / 'hj-stash' / 'private').resolve()


def ensure_private_directory(directory: Path) -> None:
    """Create new leaf with 0700, or refuse unsafe existing directory without chmod."""
    if not directory.exists():
        directory.mkdir(parents=True, mode=0o700, exist_ok=False)
    if not directory.is_dir():
        raise ValueError('Private output parent is not a directory')
    mode = stat.S_IMODE(directory.stat().st_mode)
    if mode & 0o077:
        raise PermissionError(
            'Output directory is accessible to group/others (mode %04o). '
            'Existing permissions were NOT changed. Choose a new private folder (0700).' % mode
        )


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', choices=['Production-NoAds.yaml', 'Production.yaml', 'Core.yaml'], default='Core.yaml')
    parser.add_argument('--out', help='Private output file path; parent must have permissions 0700 or stricter')
    parser.add_argument('--private-dir', default=str(DEFAULT_PRIVATE), help='Dedicated private output directory (default outside project)')
    parser.add_argument('--allow-inside-repo', action='store_true', help='Explicitly allow secrets inside repo (not recommended)')
    args = parser.parse_args(argv)

    url = (os.getenv('GLADOS_URL') or getpass.getpass('Paste GLaDOS Clash YAML HTTPS URL (hidden): ')).strip()
    if not url.startswith('https://') or 'example.invalid' in url or any(c in url for c in ('\n', '\r', ' ', '\t')):
        parser.error('A valid private HTTPS GLaDOS subscription URL is required')

    original = (ROOT / args.profile).read_text(encoding='utf-8')
    source = yaml.safe_load(original)
    placeholder = source['proxy-providers']['GLaDOS']['url']
    if not isinstance(placeholder, str) or not placeholder.startswith('https://example.invalid/') or original.count(placeholder) != 1:
        parser.error('Template placeholder missing or ambiguous')

    output = (Path(args.out).expanduser() if args.out else Path(args.private_dir).expanduser() / (args.profile.removesuffix('.yaml') + '.private.yaml')).resolve()
    if output == ROOT or (ROOT in output.parents and not args.allow_inside_repo):
        parser.error('Refuse secrets inside repository. Use a private directory outside this repository.')
    if output.exists():
        parser.error('Refuse to overwrite an existing private config')
    try:
        ensure_private_directory(output.parent)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))

    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(str(output), flags, 0o600)
    except OSError as exc:
        parser.error('Unable to create private output: ' + str(exc))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as file:
            file.write(original.replace(placeholder, url))
        rendered = yaml.safe_load(output.read_text(encoding='utf-8'))
        if rendered['proxy-providers']['GLaDOS']['url'] != url:
            raise ValueError('Rendered URL did not match')
        os.chmod(output, 0o600)
    except Exception:
        output.unlink(missing_ok=True)
        raise
    print('Created private config:', output, '(mode 0600)')
    print('Never commit, publish, paste, or add this file to a public repository.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
