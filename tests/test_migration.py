import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from migrate_profile import prepare_migration, read_legacy, unsnappy


def vint(value):
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def batch(sequence, pairs):
    output = bytearray(struct.pack('<QI', sequence, len(pairs)))
    for name, value in pairs:
        key = b'_file://\x00\x01' + name.encode()
        output.append(0 if value is None else 1)
        output.extend(vint(len(key)) + key)
        if value is not None:
            encoded = b'\x01' + json.dumps(value, ensure_ascii=False).encode('latin1')
            output.extend(vint(len(encoded)) + encoded)
    return bytes(output)


def record(kind, payload):
    return b'\x00' * 4 + struct.pack('<HB', len(payload), kind) + payload


class MigrationTest(unittest.TestCase):
    def test_read_latest_state_and_latin1_history_without_copying_authentication(self):
        with tempfile.TemporaryDirectory() as temporary:
            legacy = Path(temporary) / 'old'
            db = legacy / 'Local Storage/leveldb'
            db.mkdir(parents=True)
            old = {'activeIndex': 0, 'slots': [{'occupied': True, 'url': 'https://old.example/'}]}
            new = {'activeIndex': 3, 'slots': [{'occupied': True, 'url': 'https://new.example/'}, {'occupied': True, 'url': 'file:///unsafe'}]}
            history = [{'url': 'https://example.org', 'title': 'Überblick', 'lastVisit': 10000}]
            log = record(1, batch(1, [('focus-slots-state', old)])) + record(1, batch(2, [('focus-slots-state', new), ('focus-slots-history', history)]))
            (db / '000004.log').write_bytes(log)
            (legacy / 'Cookies').write_bytes(b'private authentication sentinel')
            target = Path(temporary) / 'new'
            report = prepare_migration(legacy, target)
            self.assertEqual(report, {'slots': 1, 'history': 1, 'bookmarks': 0})
            state = json.loads((target / 'still-slots.json').read_text())
            self.assertEqual(state['selected'], 3)
            self.assertEqual(state['slots'][0]['url'], 'https://new.example/')
            self.assertEqual(state['slots'][1]['url'], '')
            self.assertEqual(len(state['slots']), 5)
            self.assertEqual(json.loads((target / 'legacy-import.json').read_text())['history'][0]['title'], 'Überblick')
            self.assertEqual((db / '000004.log').read_bytes(), log)
            self.assertFalse((target / 'Cookies').exists())
            self.assertEqual(prepare_migration(legacy, target), {'skipped': True})

    def test_fragmented_leveldb_log_spans_blocks_and_deletions_win(self):
        with tempfile.TemporaryDirectory() as temporary:
            profile = Path(temporary)
            db = profile / 'Local Storage/leveldb'
            db.mkdir(parents=True)
            payload = batch(8, [('focus-slots-history', [{'title':'x' * 35000, 'url':'https://example.org'}])])
            log = record(2, payload[:32761]) + record(4, payload[32761:])
            log += record(1, batch(9, [('focus-slots-history', None)]))
            (db / '000003.log').write_bytes(log)
            self.assertEqual(read_legacy(profile), {})

    def test_snappy_back_reference_and_corruption(self):
        self.assertEqual(unsnappy(b'\x09\x08abc\x16\x03\x00'), b'abcabcabc')
        with self.assertRaises(ValueError):
            unsnappy(b'\x06\x16\x03\x00')


if __name__ == '__main__':
    unittest.main()
