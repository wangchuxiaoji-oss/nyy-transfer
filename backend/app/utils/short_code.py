"""短码生成器：6 位 base62，使用密码学安全 RNG。

设计要点：
- 不使用全 0/1 等易混字符；保留全部 62 字符是因为 6 位 base62 已够大（≈568 亿），
  无需额外缩字符集。
- 与系统保留路由对比由调用方负责。
"""

from __future__ import annotations

import secrets
import string

ALPHABET = string.digits + string.ascii_uppercase + string.ascii_lowercase  # 62 字符


def gen_short_code(length: int = 6) -> str:
    if length < 4:
        raise ValueError("short code length must be >= 4")
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


def is_valid_code(code: str, length: int = 6) -> bool:
    if len(code) != length:
        return False
    return all(c in ALPHABET for c in code)
