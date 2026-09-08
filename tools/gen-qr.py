#!/usr/bin/env python3
"""
gen-qr.py — write a printable QR code PNG of the live app URL to screenshots/qr-web.png,
and refresh the test fixtures that cross-check the in-app JS encoder.

    python -m pip install qrcode pillow
    python tools/gen-qr.py

The URL is read from js/config.js (APP_LINKS.web) so there is a single source of truth.
"""
import json, re
from pathlib import Path
import qrcode
from qrcode.constants import ERROR_CORRECT_M
from qrcode.util import QRData, MODE_8BIT_BYTE

ROOT = Path(__file__).resolve().parent.parent
cfg = (ROOT / "js" / "config.js").read_text(encoding="utf-8")
url = re.search(r"web:\s*'([^']+)'", cfg).group(1)

qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, box_size=12, border=4)
qr.add_data(url)
qr.make(fit=True)
img = qr.make_image(fill_color="#0b0912", back_color="#ffffff")
out = ROOT / "screenshots" / "qr-web.png"
img.save(out)
print("wrote", out, "for", url)

# Fixtures for tests/qr.test.mjs (byte mode, EC M, explicit masks).
texts = ["A", url, "Gloomfall: The Pilgrim's Road — offline PWA", "x" * 100, "https://example.com/" + "a" * 180,
         "ÿéñ 日本", "hello world 1234567890", "https://median.co/app/abcdef", "HTTPS://UPPER.CASE/URL-123"]
fixtures = []
for i, t in enumerate(texts):
    q = qrcode.QRCode(version=None, error_correction=ERROR_CORRECT_M, border=0, mask_pattern=i % 8)
    q.add_data(QRData(t.encode("utf-8"), mode=MODE_8BIT_BYTE))
    q.make(fit=True)
    fixtures.append({"text": t, "version": q.version, "mask": i % 8,
                     "rows": ["".join("1" if c else "0" for c in row) for row in q.get_matrix()]})
(ROOT / "tests" / "fixtures" / "qr.json").write_text(json.dumps(fixtures, ensure_ascii=False), encoding="utf-8")
print("wrote tests/fixtures/qr.json")
