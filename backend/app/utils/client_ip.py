"""可信客户端 IP 与游客标识提取。"""

from __future__ import annotations

from ipaddress import ip_address

from fastapi import Request


def get_client_ip(request: Request) -> str:
    """读取 Uvicorn ProxyHeaders 已校正的客户端地址。"""

    raw_ip = request.client.host if request.client else ""
    try:
        return ip_address(raw_ip).compressed
    except ValueError:
        return "0.0.0.0"


def get_guest_id(request: Request, client_ip: str | None = None) -> str:
    guest_id = getattr(request.state, "guest_id", None)
    if guest_id:
        return guest_id
    return f"ip:{client_ip or get_client_ip(request)}"
