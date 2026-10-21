#!/usr/bin/env python3
"""Create a download manifest without copying game content or loading it in memory."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit


MIN_CHUNK_SIZE = 64 * 1024
MAX_CHUNK_SIZE = 16 * 1024 * 1024
DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024
MAX_GAME_SIZE = 8 * 1024 * 1024 * 1024
MAX_MANIFEST_SIZE = 1024 * 1024


def source_url(value):
    try:
        if not value or any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in value) or '\\' in value:
            raise ValueError()
        parts = urlsplit(value)
        if (parts.scheme not in ('https', 'http') or not parts.hostname
                or parts.username is not None or parts.password is not None or '#' in value):
            raise ValueError()
        if parts.scheme == 'http' and parts.hostname not in ('localhost', '127.0.0.1', '::1'):
            raise ValueError()
        host = parts.hostname
        if '%' in host:
            raise ValueError()
        if ':' in host:
            ipaddress.IPv6Address(host)
        else:
            host = host.encode('idna').decode('ascii').lower()
            if (len(host) > 253 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', host)
                    or any(not label or len(label) > 63 or label.startswith('-') or label.endswith('-')
                           for label in host.split('.'))):
                raise ValueError()
        if parts.port == 0 or parts.netloc.endswith(':'):
            raise ValueError()
        return value
    except (ValueError, UnicodeError):
        raise ValueError('下载来源必须是无凭证、无片段的 HTTPS URL；仅本机测试可使用 HTTP') from None


def game_name(value):
    if (not value or len(value.encode('utf-8')) > 255 or value in ('.', '..')
            or any(char in '/\\:' or ord(char) < 32 or ord(char) == 127 for char in value)
            or Path(value).suffix.lower() not in ('.iso', '.cso', '.chd', '.pbp')):
        raise ValueError('游戏文件名必须是不含路径的 ISO、CSO、CHD 或 PBP 文件名（最长 255 字节）')
    return value


def fingerprint(stat):
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)


def create_manifest(path, game_id, sources, chunk_size=DEFAULT_CHUNK_SIZE, name=None):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}', game_id):
        raise ValueError('id 必须以字母或数字开头，仅含字母、数字、点、下划线或连字符，最长 64 字符')
    if type(chunk_size) is not int or not MIN_CHUNK_SIZE <= chunk_size <= MAX_CHUNK_SIZE:
        raise ValueError('分块大小必须在 65536 到 16777216 字节之间')
    if not 1 <= len(sources) <= 6:
        raise ValueError('请提供 1 到 6 个下载来源')
    urls = [source_url(value) for value in sources]
    path = Path(path)
    filename = game_name(path.name if name is None else name)
    hashes = []
    whole = hashlib.sha256()
    with path.open('rb') as source:
        before = os.fstat(source.fileno())
        if not 1 <= before.st_size <= MAX_GAME_SIZE:
            raise ValueError('游戏文件大小必须大于零且不超过 8 GiB')
        consumed = 0
        while block := source.read(chunk_size):
            consumed += len(block)
            if consumed > before.st_size:
                raise ValueError('生成清单时游戏文件发生变化，请重试')
            hashes.append(hashlib.sha256(block).hexdigest())
            whole.update(block)
        if (consumed != before.st_size or fingerprint(before) != fingerprint(os.fstat(source.fileno()))
                or fingerprint(before) != fingerprint(path.stat())):
            raise ValueError('生成清单时游戏文件发生变化，请重试')
    return {
        'schemaVersion': 1,
        'id': game_id,
        'name': filename,
        'size': consumed,
        'chunkSize': chunk_size,
        'sha256': hashes,
        'fileSha256': whole.hexdigest(),
        'sources': urls,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description='流式生成游戏分块下载清单，不复制游戏内容。')
    parser.add_argument('game', type=Path, help='本地游戏文件；请保存在已忽略的 resources 目录中')
    parser.add_argument('--id', required=True, dest='game_id', help='稳定的游戏条目标识')
    parser.add_argument('--source', required=True, action='append', help='完整游戏文件的下载 URL，可重复最多 6 次')
    parser.add_argument('--output', required=True, type=Path, help='输出清单路径（不得已存在，建议放 resources）')
    parser.add_argument('--name', help='客户端保存的文件名；默认使用输入文件名')
    parser.add_argument('--chunk-size', type=int, default=DEFAULT_CHUNK_SIZE, help='每块字节数，默认 4194304')
    args = parser.parse_args(argv)
    try:
        if args.output.exists():
            raise ValueError('输出文件已存在；请选择新路径以免覆盖已有清单或资源')
        manifest = create_manifest(args.game, args.game_id, args.source, args.chunk_size, args.name)
        encoded = json.dumps(manifest, ensure_ascii=False, indent=2) + '\n'
        if len(encoded.encode('utf-8')) > MAX_MANIFEST_SIZE:
            raise ValueError('清单超过 1 MiB，请增加 --chunk-size 后重试')
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x', encoding='utf-8', newline='\n') as destination:
            destination.write(encoded)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"已生成清单：{manifest['size']} 字节，{len(manifest['sha256'])} 块。")


if __name__ == '__main__':
    main()
