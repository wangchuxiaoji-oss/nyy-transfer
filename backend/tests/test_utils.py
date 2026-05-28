"""短码 / 安全工具的离线测试，无需数据库。"""

from __future__ import annotations

from app.utils.security import hash_secret, verify_secret
from app.utils.short_code import ALPHABET, gen_short_code, is_valid_code


def test_short_code_default_length() -> None:
    code = gen_short_code()
    assert len(code) == 6
    assert is_valid_code(code)
    assert all(c in ALPHABET for c in code)


def test_short_code_custom_length() -> None:
    for length in (4, 8, 10):
        code = gen_short_code(length)
        assert len(code) == length
        assert is_valid_code(code, length)


def test_short_code_uniqueness_smoke() -> None:
    samples = {gen_short_code() for _ in range(2000)}
    # 6 位 base62 ≈ 568 亿；2000 次几乎不可能撞
    assert len(samples) == 2000


def test_is_valid_code_rejects_bad_input() -> None:
    assert not is_valid_code("ab cd1", 6)
    assert not is_valid_code("ab", 6)
    assert not is_valid_code("abcdef", 7)


def test_secret_hash_round_trip() -> None:
    pwd = "1234"
    hashed = hash_secret(pwd)
    assert hashed != pwd
    assert verify_secret(pwd, hashed)
    assert not verify_secret("0000", hashed)
