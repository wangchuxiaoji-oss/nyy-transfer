"""应用配置，使用 pydantic-settings 从环境变量 / .env 读取。"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, model_validator
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
    test_database_url: str = ""
    test_database_sync_url: str = ""

    # Redis
    redis_url: str = "redis://127.0.0.1:6379/0"

    # 安全
    secret_key: str = Field(default="change-me-please-32-bytes-minimum-secret", min_length=32)
    session_cookie_name: str = "nyy_session"
    csrf_cookie_name: str = "nyy_csrf"

    # 短码
    short_code_length: int = 6

    # 上传 / 配额
    guest_max_file_bytes: int = 2 * 1024 * 1024 * 1024
    guest_max_file_size: int = 2 * 1024 * 1024 * 1024
    guest_max_active_shares: int = 5
    guest_max_files_per_share: int = 10
    guest_ttl_hours: int = 24
    user_max_file_bytes: int = 50 * 1024 * 1024 * 1024
    user_max_file_size: int = 10 * 1024 * 1024 * 1024
    user_max_active_shares: int = 30
    user_max_files_per_share: int = 50
    platform_max_file_bytes: int = 10 * 1024 * 1024 * 1024
    platform_max_share_bytes: int = 50 * 1024 * 1024 * 1024
    platform_max_files_per_share: int = 500
    platform_max_empty_dirs_per_share: int = 500
    platform_max_retention_hours: int = 90 * 24
    platform_max_active_links: int = 200
    platform_max_concurrent_upload_batches: int = 10
    platform_max_request_bytes: int = 10 * 1024 * 1024 * 1024
    platform_max_request_files: int = 100
    # 上传重试
    upload_max_retries: int = 3

    # 豆包 file station
    doubao_file_station_base_url: str = "http://127.0.0.1:9190"
    doubao_file_station_api_key: str = "sk-local"
    doubao_session_file: str | None = None
    doubao_download_fallback_session_files: str = ""
    doubao_auto_verify_enabled: bool = True
    doubao_auto_verify_startup_delay_seconds: int = 30
    doubao_auto_verify_heartbeat_interval_seconds: int = 600
    doubao_auto_verify_probe_interval_seconds: int = 1800
    doubao_auto_verify_failure_notify_interval_seconds: int = 21600

    # Bark 推送，建议填写完整地址：https://api.day.app/<key>
    bark_push_url: str = ""

    # Email
    smtp_host: str = "127.0.0.1"
    smtp_port: int = 25
    email_from: str = "noreply@nyy.app"

    # Debug log ingestion, intended for dev diagnostics only.
    debug_log_ingest_enabled: bool = False
    debug_log_dir: str = ""

    # IP 来源
    geoip_city_db: str = ""
    geoip_asn_db: str = ""
    share_access_retention_days: int = 180
    share_view_dedupe_minutes: int = 10
    admin_preview_sign_concurrency: int = 8
    share_archive_retention_days: int = 180
    share_archive_enabled: bool = False
    nginx_access_log_path: str = "/var/log/nginx/nyy_access.json"
    nginx_access_state_path: str = "runtime/nginx_access_import_state.json"
    nginx_access_import_batch_size: int = 1000

    # 认证 - Token
    jwt_secret: str = Field(default="change-me-jwt-secret-at-least-32-bytes!!", min_length=32)
    jwt_algorithm: str = "HS256"
    auth_access_token_expire_minutes: int = 15
    auth_refresh_token_expire_days: int = 30
    auth_refresh_cookie_name: str = "nyy_refresh_token"
    auth_cookie_secure: bool = True
    auth_cookie_samesite: str = "lax"
    auth_cookie_domain: str | None = None

    # 认证 - ALTCHA 验证码
    captcha_hmac_secret: str = Field(default="change-me-captcha-hmac-secret-32bytes!", min_length=32)
    captcha_challenge_ttl_seconds: int = 180
    captcha_token_ttl_seconds: int = 300
    altcha_algorithm: str = "PBKDF2/SHA-256"
    altcha_cost: int = 5_000

    # 认证 - 邮箱验证码
    email_code_secret: str = Field(default="change-me-email-code-secret-32bytes!", min_length=32)
    email_code_ttl_minutes: int = 10
    email_code_max_attempts: int = 5
    email_code_resend_cooldown_seconds: int = 60
    email_code_email_hourly_limit: int = 5
    email_code_ip_hourly_limit: int = 20
    email_code_ip_daily_limit: int = 100

    # 认证 - 登录风控
    login_email_failure_captcha_threshold: int = 3
    login_ip_failure_captcha_threshold: int = 10
    login_ip_failure_rate_limit: int = 30

    @model_validator(mode="after")
    def validate_production_auth_secrets(self) -> Settings:
        if self.app_env == "dev":
            return self
        defaults = {
            "SECRET_KEY": self.secret_key,
            "JWT_SECRET": self.jwt_secret,
            "CAPTCHA_HMAC_SECRET": self.captcha_hmac_secret,
            "EMAIL_CODE_SECRET": self.email_code_secret,
        }
        weak = [name for name, value in defaults.items() if value.startswith("change-me")]
        if weak:
            raise ValueError(f"生产环境必须设置非默认认证密钥: {', '.join(weak)}")
        if self.app_base_url.rstrip("/") != "https://nyy.app":
            raise ValueError("生产环境必须设置 APP_BASE_URL=https://nyy.app")
        if "nyy:nyy@" in self.database_url or "nyy:nyy@" in self.database_sync_url:
            raise ValueError("生产环境必须替换默认数据库凭据")
        if not self.doubao_file_station_api_key or self.doubao_file_station_api_key == "sk-local" or self.doubao_file_station_api_key.startswith("change-me"):
            raise ValueError("生产环境必须设置非默认豆包 API 密钥")
        if not self.auth_cookie_secure:
            raise ValueError("生产环境必须设置 AUTH_COOKIE_SECURE=true")
        return self

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
