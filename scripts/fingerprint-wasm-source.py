#!/usr/bin/env python3
"""Fingerprint the actual core source bytes selected by a Git source inventory.

The source root may be a separate compilation checkout or synchronized cache.
The inventory root supplies tracked and non-ignored new core files. Generated
build directories are omitted by Git ignore rules. Only the digest is printed.
"""
import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import subprocess


CORE_PREFIX = PurePosixPath('deps/ppsspp-wasm')
REPO = Path(__file__).resolve().parents[1]


class FingerprintError(ValueError):
    """A source tree could not be fingerprinted without ambiguity."""


def git_output(root, *arguments):
    try:
        result = subprocess.run(['git', '-C', str(root), *arguments], capture_output=True, check=False)
    except OSError as error:
        raise FingerprintError('Git is required to inventory the source tree.') from error
    if result.returncode != 0:
        raise FingerprintError('Git could not inventory the source tree.')
    return result.stdout


def source_inventory(inventory_root):
    root_bytes = git_output(inventory_root, 'rev-parse', '--show-toplevel').rstrip(b'\r\n')
    try:
        git_root = Path(os.fsdecode(root_bytes)).resolve(strict=True)
    except OSError as error:
        raise FingerprintError('The source inventory root is unavailable.') from error
    listing = git_output(git_root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard',
                         '--full-name', '--', CORE_PREFIX.as_posix())
    names = sorted(set(name for name in listing.split(b'\0') if name))
    if not names:
        raise FingerprintError('The source inventory contains no core files.')
    relative = []
    for name in names:
        entry = PurePosixPath(os.fsdecode(name))
        if entry.is_absolute() or '..' in entry.parts or entry.parts[:2] != CORE_PREFIX.parts:
            raise FingerprintError('The source inventory contains an invalid relative path.')
        relative.append((name, entry.relative_to(CORE_PREFIX)))
    return git_root, relative


def fingerprint_source(source_root=None, inventory_root=REPO):
    """Return SHA-256 over sorted repository paths, file lengths and source bytes."""
    inventory_root, entries = source_inventory(inventory_root)
    try:
        root = Path(source_root if source_root is not None else inventory_root / CORE_PREFIX).resolve(strict=True)
    except OSError as error:
        raise FingerprintError('The compilation source root is unavailable.') from error
    if not root.is_dir():
        raise FingerprintError('The compilation source root must be a directory.')
    digest = hashlib.sha256(b'wasm-source-fingerprint-v1\0')
    for name, relative in entries:
        try:
            source = root.joinpath(*relative.parts).resolve(strict=True)
            if not source.is_relative_to(root):
                raise FingerprintError('A source link escapes the compilation source root.')
            if not source.is_file():
                raise FingerprintError('An inventoried source entry is not a regular file.')
            with source.open('rb') as stream:
                before = os.fstat(stream.fileno())
                digest.update(len(name).to_bytes(8, 'big'))
                digest.update(name)
                digest.update(before.st_size.to_bytes(8, 'big'))
                size = 0
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
                    size += len(chunk)
                after = os.fstat(stream.fileno())
                if size != before.st_size or (before.st_size, before.st_mtime_ns, before.st_ino) != \
                        (after.st_size, after.st_mtime_ns, after.st_ino):
                    raise FingerprintError('A compilation source file changed during fingerprinting.')
        except OSError as error:
            raise FingerprintError('An inventoried compilation source file is missing or unreadable.') from error
    return digest.hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, help='Actual compilation core directory; defaults to the inventory core')
    parser.add_argument('--inventory-root', type=Path, default=REPO, help='Git checkout providing the core file inventory')
    args = parser.parse_args(argv)
    try:
        print(fingerprint_source(args.source_root, args.inventory_root))
    except FingerprintError as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
