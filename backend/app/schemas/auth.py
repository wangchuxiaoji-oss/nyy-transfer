"""认证相关 Pydantic schemas。"""

from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field


# ─── 注册 ────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class SendCodeRequest(BaseModel):
    email: EmailStr
    purpose: str = Field(default="register", pattern="^(register|reset_password)$")


class VerifyEmailRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6)


# ─── 登录 ────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int  # seconds


class RefreshRequest(BaseModel):
    refresh_token: str


# ─── 重置密码 ────────────────────────────────────────────────────

class ResetPasswordRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6)
    new_password: str = Field(min_length=8, max_length=128)


# ─── 通用响应 ────────────────────────────────────────────────────

class MessageResponse(BaseModel):
    message: str


class UserInfoResponse(BaseModel):
    id: str
    email: str
    plan: str
    email_verified: bool
