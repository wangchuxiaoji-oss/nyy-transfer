from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def extract(pattern: str, path: Path) -> str:
    match = re.search(pattern, path.read_text(encoding="utf-8"), re.MULTILINE)
    if match is None:
        raise RuntimeError(f"无法从 {path.relative_to(ROOT)} 读取版本号")
    return match.group(1)


def main() -> None:
    expected = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    package = json.loads((ROOT / "frontend/package.json").read_text(encoding="utf-8"))
    package_lock = json.loads((ROOT / "frontend/package-lock.json").read_text(encoding="utf-8"))
    versions = {
        "backend/app/__init__.py": extract(
            r'^__version__\s*=\s*"([^"]+)"$', ROOT / "backend/app/__init__.py"
        ),
        "backend/pyproject.toml": extract(
            r'^version\s*=\s*"([^"]+)"$', ROOT / "backend/pyproject.toml"
        ),
        "frontend/package.json": package["version"],
        "frontend/package-lock.json": package_lock["version"],
        'frontend/package-lock.json packages[""]': package_lock["packages"][""]["version"],
    }
    mismatches = {path: version for path, version in versions.items() if version != expected}
    if mismatches:
        details = ", ".join(f"{path}={version}" for path, version in mismatches.items())
        raise SystemExit(f"版本不一致，期望 {expected}：{details}")
    print(f"版本一致：{expected}")


if __name__ == "__main__":
    main()
