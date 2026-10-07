#!/usr/bin/env python3
"""Read Still 0.1.x's LevelDB browsing state without opening or modifying it.

Only slots, visit history, and custom bookmarks are decoded. Authentication
databases and other browser profiles are never opened.
"""
import json
from pathlib import Path
import struct

NAMES = {'focus-slots-state', 'focus-slots-history', 'still-custom-bookmarks'}


def varint(data, position):
    value = shift = 0
    while shift < 64:
        byte = data[position]
        position += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, position
        shift += 7
    raise ValueError('Invalid LevelDB varint')


def unsnappy(data):
    expected, position = varint(data, 0)
    if expected > 16 * 1024 * 1024:
        raise ValueError('Oversized LevelDB block')
    output = bytearray()
    while position < len(data):
        tag = data[position]
        position += 1
        kind = tag & 3
        if kind == 0:
            length = tag >> 2
            if length >= 60:
                size = length - 59
                length = int.from_bytes(data[position:position + size], 'little')
                position += size
            length += 1
            output.extend(data[position:position + length])
            position += length
        else:
            if kind == 1:
                length = ((tag >> 2) & 7) + 4
                offset = ((tag & 224) << 3) | data[position]
                position += 1
            else:
                length = (tag >> 2) + 1
                size = 2 if kind == 2 else 4
                offset = int.from_bytes(data[position:position + size], 'little')
                position += size
            if offset < 1 or offset > len(output):
                raise ValueError('Invalid Snappy back-reference')
            for _ in range(length):
                output.append(output[-offset])
        if len(output) > expected:
            raise ValueError('Invalid Snappy block length')
    if len(output) != expected:
        raise ValueError('Truncated Snappy block')
    return bytes(output)


def block(data, offset, length):
    contents = data[offset:offset + length]
    kind = data[offset + length]
    if kind == 0:
        return contents
    if kind == 1:
        return unsnappy(contents)
    raise ValueError('Unsupported LevelDB compression')


def block_entries(contents):
    count = struct.unpack_from('<I', contents, len(contents) - 4)[0]
    end = len(contents) - 4 - count * 4
    if end < 0:
        raise ValueError('Invalid LevelDB restart table')
    position = 0
    previous = b''
    while position < end:
        shared, position = varint(contents, position)
        unique, position = varint(contents, position)
        length, position = varint(contents, position)
        if shared > len(previous) or position + unique + length > end:
            raise ValueError('Truncated LevelDB entry')
        key = previous[:shared] + contents[position:position + unique]
        position += unique
        value = contents[position:position + length]
        position += length
        previous = key
        yield key, value


def table_entries(data):
    if data[-8:] != struct.pack('<Q', 0xdb4775248b80fb57):
        raise ValueError('Unknown LevelDB table format')
    _, position = varint(data, len(data) - 48)
    _, position = varint(data, position)
    offset, position = varint(data, position)
    length, position = varint(data, position)
    for _, handle in block_entries(block(data, offset, length)):
        offset, p = varint(handle, 0)
        length, p = varint(handle, p)
        for key, value in block_entries(block(data, offset, length)):
            tag = int.from_bytes(key[-8:], 'little')
            yield tag >> 8, key[:-8], value if tag & 255 == 1 else None


def log_entries(data):
    fragments = bytearray()
    for boundary in range(0, len(data), 32768):
        position = boundary
        end = min(boundary + 32768, len(data))
        while position + 7 <= end:
            length = struct.unpack_from('<H', data, position + 4)[0]
            kind = data[position + 6]
            position += 7
            if not length or position + length > end:
                break
            chunk = data[position:position + length]
            position += length
            if kind == 1:
                record = chunk
            elif kind == 2:
                fragments = bytearray(chunk)
                continue
            elif kind == 3:
                fragments.extend(chunk)
                continue
            elif kind == 4:
                fragments.extend(chunk)
                record = bytes(fragments)
                fragments.clear()
            else:
                continue
            if len(record) < 12:
                continue
            sequence, count = struct.unpack_from('<QI', record)
            p = 12
            for i in range(count):
                tag = record[p]
                p += 1
                length, p = varint(record, p)
                key = record[p:p + length]
                p += length
                value = None
                if tag == 1:
                    length, p = varint(record, p)
                    value = record[p:p + length]
                    p += length
                elif tag != 0:
                    raise ValueError('Invalid LevelDB write batch')
                yield sequence + i, key, value


def read_legacy(profile):
    directory = profile / 'Local Storage' / 'leveldb'
    latest = {}
    for file in sorted(directory.glob('*')):
        if file.suffix not in {'.log', '.ldb', '.sst'} or file.stat().st_size > 64 * 1024 * 1024:
            continue
        try:
            reader = log_entries if file.suffix == '.log' else table_entries
            for sequence, key, value in reader(file.read_bytes()):
                for name in NAMES:
                    # Chromium's file-origin localStorage key has a one-byte
                    # string marker immediately before the UTF-8 key name.
                    if key.endswith(b'\x01' + name.encode()) and key.startswith(b'_file://\x00'):
                        if sequence >= latest.get(name, (-1, None))[0]:
                            latest[name] = (sequence, value)
        except (ValueError, IndexError, struct.error, OSError):
            continue
    values = {}
    for name, (_, value) in latest.items():
        if not value:
            continue
        try:
            values[name] = json.loads(value[1:].decode('utf-16-le' if value[0] == 0 else 'latin1'))
        except (UnicodeError, ValueError, IndexError):
            continue
    return values


def prepare_migration(legacy, target):
    if (target / 'still-slots.json').exists() or (target / 'prefs.js').exists():
        return {'skipped': True}
    values = read_legacy(legacy)
    saved = values.get('focus-slots-state', {})
    slots = []
    for item in saved.get('slots', [])[:5]:
        url = str(item.get('url', ''))
        slots.append({'url': url if item.get('occupied') and url.startswith(('https://', 'http://')) else '', 'title': str(item.get('title', ''))})
    slots.extend({'url': '', 'title': ''} for _ in range(5 - len(slots)))
    state = {'version': 2, 'selected': max(0, min(4, int(saved.get('activeIndex', 0)))), 'slots': slots}
    history = [item for item in values.get('focus-slots-history', []) if str(item.get('url', '')).startswith(('https://', 'http://'))][:5000]
    bookmarks = [item for item in values.get('still-custom-bookmarks', []) if str(item.get('url', '')).startswith(('https://', 'http://'))][:5000]
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    (target / 'still-slots.json').write_text(json.dumps(state, ensure_ascii=False))
    (target / 'legacy-import.json').write_text(json.dumps({'history': history, 'bookmarks': bookmarks}, ensure_ascii=False))
    for name in ['still-slots.json', 'legacy-import.json']:
        (target / name).chmod(0o600)
    return {'slots': sum(bool(item['url']) for item in slots), 'history': len(history), 'bookmarks': len(bookmarks)}
