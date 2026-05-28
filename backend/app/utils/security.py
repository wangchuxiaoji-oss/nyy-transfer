"""密码 / 提取码哈希工具。

提取码用 argon2id，参数为 argon2-cffi 默认值（适合 Web 场景）。
"""

from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

_hasher = PasswordHasher()


def hash_secret(plain: str) -> str:
    return _hasher.hash(plain)


def verify_secret(plain: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, plain)
    except VerifyMismatchError:
        return False
    except Exception:  # noqa: BLE001 - argon2 抛多种异常，统一视为失败
        return False
