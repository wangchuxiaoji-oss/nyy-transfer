"""下载并原子更新 DB-IP ASN Lite MMDB。"""

from __future__ import annotations

import argparse
import gzip
import os
import re
import tempfile
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

import maxminddb

MAX_COMPRESSED_BYTES = 32 * 1024 * 1024
MAX_DATABASE_BYTES = 64 * 1024 * 1024
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="更新 DB-IP ASN Lite 数据库")
    parser.add_argument("--month", default=datetime.now(UTC).strftime("%Y-%m"))
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(
            os.environ.get("GEOIP_ASN_DB", "/data/nyy/backend/var/geoip/DBIP-ASN-Lite.mmdb")
        ),
    )
    return parser.parse_args()


def download_database(month: str) -> bytes:
    if not MONTH_RE.fullmatch(month):
        raise ValueError("月份必须使用 YYYY-MM 格式")
    url = f"https://download.db-ip.com/free/dbip-asn-lite-{month}.mmdb.gz"
    request = urllib.request.Request(url, headers={"User-Agent": "nyy-geoip-updater/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        compressed = response.read(MAX_COMPRESSED_BYTES + 1)
    if len(compressed) > MAX_COMPRESSED_BYTES:
        raise ValueError("下载文件超过大小限制")
    database = gzip.decompress(compressed)
    if len(database) > MAX_DATABASE_BYTES:
        raise ValueError("解压后的数据库超过大小限制")
    return database


def validate_database(path: Path) -> str:
    reader = maxminddb.open_database(str(path))
    try:
        database_type = reader.metadata().database_type
        sample = reader.get("8.8.8.8") or {}
    finally:
        reader.close()
    if "ASN" not in database_type or not sample.get("autonomous_system_organization"):
        raise ValueError(f"数据库格式不符合预期: {database_type}")
    return database_type


def main() -> None:
    args = parse_args()
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    database = download_database(args.month)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=output.parent,
            prefix=f".{output.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary.write(database)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        database_type = validate_database(temporary_path)
        temporary_path.chmod(0o644)
        os.replace(temporary_path, output)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    print(f"已安装 {database_type}: {output}")


if __name__ == "__main__":
    main()
