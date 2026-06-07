"""弱密码字典检查。"""

from __future__ import annotations

# 常见弱密码，涵盖 top-100 级别和站点相关
_WEAK_PASSWORDS: set[str] = {
    # 数字类
    "12345678", "123456789", "1234567890", "00000000", "11111111",
    "22222222", "33333333", "44444444", "55555555", "66666666",
    "77777777", "88888888", "99999999", "12341234", "11223344",
    # 常见密码
    "password", "password1", "password12", "password123",
    "qwerty123", "qwerty1234", "qwertyuiop", "asdfghjkl",
    "zxcvbnm123", "abc123456", "abcdef123", "iloveyou1",
    "letmein123", "welcome123", "monkey123", "dragon123",
    "master123", "login1234", "princess1", "shadow123",
    "sunshine1", "football1", "baseball1", "trustno1",
    "1q2w3e4r5", "q1w2e3r4t", "admin1234", "passw0rd",
    # 站点相关
    "nyy123456", "nayayaya", "nyyapp123", "nyy.app12",
}


def is_weak_password(password: str, email: str = "") -> bool:
    """检查密码是否过于常见。

    规则：
    - 不能在弱密码字典中
    - 不能与邮箱本地部分完全相同或过于接近
    """
    pw_lower = password.lower()

    if pw_lower in _WEAK_PASSWORDS:
        return True

    if email:
        local = email.split("@")[0].lower()
        if pw_lower == local:
            return True
        if len(local) >= 4 and local in pw_lower and len(pw_lower) <= len(local) + 3:
            return True

    return False
