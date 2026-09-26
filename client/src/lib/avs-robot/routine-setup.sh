#!/bin/bash
# AVS routine environment: what the AVS tools need (PDF rendering, OCR for
# scanned POs, fonts for the report, and the Python libraries).
if command -v apt-get >/dev/null 2>&1; then
  SUDO=""; if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo -n"; fi
  $SUDO apt-get update -qq >/dev/null 2>&1
  $SUDO apt-get install -y -qq poppler-utils tesseract-ocr fonts-dejavu-core >/dev/null 2>&1 || true
fi
python3 -m pip install -q --break-system-packages reportlab pillow pillow-heif zxing-cpp 2>/dev/null \
  || python3 -m pip install -q reportlab pillow pillow-heif zxing-cpp
exit 0
