import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeQR } from '../js/core/qr.js';

// Reference matrices produced by the Python `qrcode` library (EC level M, byte mode,
// no quiet zone). Regenerate with the snippet in tools/gen-qr.py.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/qr.json', import.meta.url), 'utf8'));

for (const f of fixtures) {
  test(`QR matches the reference encoder: ${JSON.stringify(f.text.slice(0, 30))} (v${f.version}, mask ${f.mask})`, () => {
    // Force the reference mask so the comparison is exact; automatic selection is tested below.
    const qr = encodeQR(f.text, { mask: f.mask });
    assert.equal(qr.version, f.version);
    assert.equal(qr.size, f.rows.length);
    const rows = [];
    for (let y = 0; y < qr.size; y++) { let s = ''; for (let x = 0; x < qr.size; x++) s += qr.get(x, y) ? '1' : '0'; rows.push(s); }
    assert.deepEqual(rows, f.rows);
  });
}

test('automatic mask picks a valid mask and stays decodable-shaped', () => {
  const qr = encodeQR('https://sultan-alkaabi-hub.github.io/Fantasy_Claude/');
  assert.ok(qr.mask >= 0 && qr.mask <= 7);
  // finder pattern corners are intact
  assert.equal(qr.get(0, 0), true); assert.equal(qr.get(qr.size - 1, 0), true); assert.equal(qr.get(0, qr.size - 1), true);
  assert.equal(qr.get(1, 1), false);
});

test('rejects text that does not fit in version 10', () => {
  assert.throws(() => encodeQR('x'.repeat(300)));
});
