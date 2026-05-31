"""应用配置，使用 pydantic-settings 从环境变量 / .env 读取。"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """全局配置。所有字段都可通过环境变量覆盖。"""

    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parents[2] / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # 应用
    app_name: str = "nyy"
    app_env: str = "dev"
    app_base_url: str = "http://127.0.0.1:8000"
    app_log_level: str = "INFO"

    # 服务
    host: str = "127.0.0.1"
    port: int = 8000

    # 数据库
    database_url: str = (
        "postgresql+asyncpg://nyy:nyy@127.0.0.1:5432/nyy"
    )
    database_sync_url: str = (
        "postgresql+psycopg://nyy:nyy@127.0.0.1:5432/nyy"
    )

    # Redis
    redis_url: str = "redis://127.0.0.1:6379/0"

    # 安全
    secret_key: str = Field(default="change-me-please-32-bytes-minimum-secret", min_length=32)
    session_cookie_name: str = "nyy_session"
    csrf_cookie_name: str = "nyy_csrf"

    # 短码
    short_code_length: int = 6

    # 上传 / 配额
    guest_max_file_bytes: int = 200 * 1024 * 1024
    guest_max_file_size: int = 1024 * 1024 * 1024  # 单文件上限 1 GiB
    guest_max_active_shares: int = 2
    guest_max_files_per_share: int = 10
    guest_ttl_hours: int = 24
    user_max_file_bytes: int = 1024 * 1024 * 1024
    user_max_active_shares: int = 20
    user_max_files_per_share: int = 50
    # 上传重试
    upload_max_retries: int = 3

    # 豆包 file station
    doubao_file_station_base_url: str = "http://127.0.0.1:9190"
    doubao_file_station_api_key: str = "sk-local"
    doubao_session_file: str | None = None

    # Captcha
    hcaptcha_site_key: str = ""
    hcaptcha_secret: str = ""

    # Email
    smtp_host: str = "127.0.0.1"
    smtp_port: int = 25
    email_from: str = "noreply@nyy.app"

    # Debug log ingestion, intended for dev diagnostics only.
    debug_log_ingest_enabled: bool = False
    debug_log_dir: str = ""

    # 认证
    jwt_secret: str = Field(default="change-me-jwt-secret-at-least-32-bytes!!", min_length=32)
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 60 * 24  # 24h
    jwt_refresh_token_expire_days: int = 30
    auth_code_ttl_minutes: int = 15
    auth_code_max_attempts: int = 5  # 验证码最大尝试次数
    auth_code_rate_limit: int = 5   # 每邮箱每小时最多发 N 次

    @property
    def is_dev(self) -> bool:
        return self.app_env == "dev"

    @property
    def project_root(self) -> Path:
        return Path(__file__).resolve().parents[2]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """全局单例。lru_cache 在测试里可用 ``get_settings.cache_clear()`` 重置。"""

    return Settings()
