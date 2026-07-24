"""本地 MMDB IP 来源查询。"""

from __future__ import annotations

import logging
from functools import lru_cache
from ipaddress import ip_address
from pathlib import Path
from typing import Any

from app.core.config import get_settings

log = logging.getLogger(__name__)


def _empty_geo() -> dict[str, str]:
    return {"country": "", "region": "", "city": "", "isp": ""}


@lru_cache(maxsize=4)
def _open_reader(path_value: str):
    if not path_value:
        return None
    path = Path(path_value).expanduser()
    if not path.is_file():
        return None
    try:
        import geoip2.database

        return geoip2.database.Reader(str(path))
    except Exception as exc:
        log.warning("failed to open GeoIP database %s: %s", path, exc)
        return None


def _localized_name(record: Any) -> str:
    names = getattr(record, "names", None) or {}
    return str(names.get("zh-CN") or names.get("en") or getattr(record, "name", "") or "")


@lru_cache(maxsize=8192)
def lookup_ip_source(ip_value: str | None) -> dict[str, str]:
    if not ip_value:
        return _empty_geo()
    try:
        parsed = ip_address(ip_value)
    except ValueError:
        return _empty_geo()
    if not parsed.is_global:
        return {"country": "内网", "region": "", "city": "", "isp": ""}

    settings = get_settings()
    result = _empty_geo()
    city_reader = _open_reader(settings.geoip_city_db)
    if city_reader is not None:
        try:
            response = city_reader.city(ip_value)
            result["country"] = _localized_name(response.country)
            subdivisions = list(response.subdivisions)
            if subdivisions:
                result["region"] = _localized_name(subdivisions[0])
            result["city"] = _localized_name(response.city)
        except Exception:
            pass

    asn_reader = _open_reader(settings.geoip_asn_db)
    if asn_reader is not None:
        try:
            response = asn_reader.asn(ip_value)
            result["isp"] = str(response.autonomous_system_organization or "")
        except Exception:
            pass
    return result
