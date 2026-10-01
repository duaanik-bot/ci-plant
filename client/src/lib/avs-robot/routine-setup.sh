#!/bin/bash
# AVS routine environment: what the AVS tools need (PDF rendering, OCR for
# scanned POs, fonts for the report, and the Python libraries).
# Since 1 Oct 2026 this runs in the BACKGROUND, so the session starts at once
# and Claude claims its set while the tools install. The check waits for
# /tmp/avs-setup.done before its first PDF or OCR step (routine-prompt.md).
rm -f /tmp/avs-setup.done
(
  need_apt=0
  for t in pdftoppm pdftotext tesseract; do command -v "$t" >/dev/null 2>&1 || need_apt=1; done
  if [ "$need_apt" = 1 ] && command -v apt-get >/dev/null 2>&1; then
    SUDO=""; if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo -n"; fi
    PKGS="poppler-utils tesseract-ocr fonts-dejavu-core"
    $SUDO apt-get install -y -qq --no-install-recommends $PKGS >/dev/null 2>&1 \
      || { $SUDO apt-get update -qq >/dev/null 2>&1; $SUDO apt-get install -y -qq --no-install-recommends $PKGS >/dev/null 2>&1; }
  fi
  if ! python3 -c 'import reportlab, PIL, pillow_heif, zxingcpp' 2>/dev/null; then
    python3 -m pip install -q --break-system-packages reportlab pillow pillow-heif zxing-cpp 2>/dev/null \
      || python3 -m pip install -q reportlab pillow pillow-heif zxing-cpp
  fi
  date -u +%FT%TZ > /tmp/avs-setup.done
) > /tmp/avs-setup.log 2>&1 < /dev/null &
disown 2>/dev/null || true
exit 0
