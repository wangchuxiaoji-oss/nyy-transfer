#!/usr/bin/env python3
"""
Doubao QR Login - Standalone CLI tool.

Usage:
    python3 run.py [--output /path/to/.doubao_session.json] [--port 8899]

Starts a QR login flow, serves the QR image on a temporary HTTP port,
and saves the session to the specified file on success.
"""

import argparse
import http.server
import json
import os
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from qr_login import QRLogin, QRStatus, QRResult, generate_device_params


DEFAULT_OUTPUT = "/data/nyy/backend/.doubao_session.json"
DEFAULT_PORT = 8899


class QRImageHandler(http.server.BaseHTTPRequestHandler):
    """Serves the QR code PNG image."""
    qr_data = b""

    def do_GET(self):
        if self.path in ("/", "/qr.png"):
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(self.qr_data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(self.qr_data)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # suppress logs


def serve_qr_image(port: int, qr_data: bytes) -> http.server.HTTPServer:
    """Start a tiny HTTP server to serve the QR image."""
    QRImageHandler.qr_data = qr_data
    server = http.server.HTTPServer(("0.0.0.0", port), QRImageHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def save_session(result: QRResult, output_path: str):
    """Save session cookies and params to JSON file."""
    data = {
        "cookies": result.cookies,
        "sessionid": result.sessionid,
        "params": result.device_params,
        "timestamp": int(time.time()),
        "source": "qr_login",
    }
    Path(output_path).write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def main():
    parser = argparse.ArgumentParser(description="Doubao QR Login")
    parser.add_argument(
        "--output", "-o", default=DEFAULT_OUTPUT,
        help=f"Output session file (default: {DEFAULT_OUTPUT})"
    )
    parser.add_argument(
        "--port", "-p", type=int, default=DEFAULT_PORT,
        help=f"HTTP port to serve QR image (default: {DEFAULT_PORT})"
    )
    args = parser.parse_args()

    print()
    print("  Doubao QR Login Tool")
    print("  " + "=" * 40)
    print(f"  Output: {args.output}")
    print(f"  QR Port: {args.port}")
    print()

    # Event to signal completion
    done_event = threading.Event()
    final_result = [None]

    def on_status(status: QRStatus, msg: str):
        if msg == "qr_ready":
            return
        icons = {
            QRStatus.FETCHING_QR: "[...]",
            QRStatus.WAITING_SCAN: "[QR ]",
            QRStatus.SCANNED: "[OK ]",
            QRStatus.CONFIRMED: "[+] ",
            QRStatus.EXPIRED: "[!] ",
            QRStatus.ERROR: "[X] ",
        }
        icon = icons.get(status, "[?] ")
        print(f"  {icon} {msg}")

    def on_done(result: QRResult):
        final_result[0] = result
        done_event.set()

    qr = QRLogin()
    qr.start(on_status=on_status, on_done=on_done)

    # Wait for QR code to be generated
    for _ in range(40):
        time.sleep(0.1)
        if qr.qrcode_data:
            break

    if not qr.qrcode_data:
        print("  [X] Failed to generate QR code")
        sys.exit(1)

    # Save QR image to file as backup
    qr_path = Path(__file__).parent / "qr.png"
    qr_path.write_bytes(qr.qrcode_data)

    # Start HTTP server
    server = serve_qr_image(args.port, qr.qrcode_data)

    print(f"  [QR ] QR code ready! Scan with Doubao app:")
    print(f"         http://103.237.92.203:{args.port}/qr.png")
    print(f"         (also saved to {qr_path})")
    print()
    print("  Waiting for scan... (Ctrl+C to cancel)")
    print()

    try:
        done_event.wait(timeout=130)
    except KeyboardInterrupt:
        qr.cancel()
        print()
        print("  Cancelled.")
        server.shutdown()
        sys.exit(1)

    server.shutdown()
    result = final_result[0]

    if result and result.status == QRStatus.CONFIRMED:
        save_session(result, args.output)
        print(f"  [+]  Session saved to {args.output}")
        print(f"       sessionid: {result.sessionid[:16]}...")
        print(f"       cookies: {len(result.cookies)} keys")
        print()
        # Clean up QR image
        qr_path = Path(__file__).parent / "qr.png"
        qr_path.unlink(missing_ok=True)
    else:
        error = result.error if result else "Unknown error"
        print(f"  [X]  Login failed: {error}")
        sys.exit(1)


if __name__ == "__main__":
    main()
