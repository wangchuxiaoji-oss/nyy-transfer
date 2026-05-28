"""豆包 TOS 上传服务封装。

nyy 后端只做 prepare → apply → commit 三步的 API 调用，
文件本体由浏览器直传 TOS（CORS 已验证放行）。

本模块使用 httpx（async）而非 aiohttp，与 nyy 技术栈一致。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs, quote, urlencode, urlparse

import httpx

from app.core.config import get_settings

log = logging.getLogger(__name__)

# --- AWS Signature V4 (inline, 避免对 doubao-file-station 的运行时依赖) ---

def _aws_sign_v4(
    method: str,
    url: str,
    body: str,
    access_key: str,
    secret_key: str,
    session_token: str,
    region: str = "cn-north-1",
    service: str = "imagex",
) -> dict[str, str]:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    path = parsed.path or "/"
    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")

    query_params = parse_qs(parsed.query, keep_blank_values=True)
    sorted_params = sorted((k, v[0] if v else "") for k, v in query_params.items())
    canonical_qs = "&".join(f"{quote(k, safe='~')}={quote(v, safe='~')}" for k, v in sorted_params)

    headers_to_sign: dict[str, str] = {"host": host, "x-amz-date": amz_date}
    if session_token:
        headers_to_sign["x-amz-security-token"] = session_token
    signed_headers = ";".join(sorted(headers_to_sign.keys()))
    canonical_headers = "".join(f"{k}:{v}\n" for k, v in sorted(headers_to_sign.items()))

    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    payload_hash = hashlib.sha256(body_bytes).hexdigest()
    canonical_request = (
        f"{method}\n{path}\n{canonical_qs}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    )
    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
    cr_hash = hashlib.sha256(canonical_request.encode()).hexdigest()
    string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{cr_hash}"

    def _sign(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode(), hashlib.sha256).digest()

    k_date = _sign(f"AWS4{secret_key}".encode(), date_stamp)
    k_region = _sign(k_date, region)
    k_service = _sign(k_region, service)
    k_signing = _sign(k_service, "aws4_request")
    signature = hmac.new(k_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()

    authorization = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    result = {"Authorization": authorization, "X-Amz-Date": amz_date}
    if session_token:
        result["X-Amz-Security-Token"] = session_token
    return result


# --- Data models ---

class DoubaoClientError(Exception):
    """豆包 API 调用失败。"""


@dataclass
class UploadInitResult:
    """init_upload 返回值，前端用来直传 TOS。"""
    upload_url: str
    authorization: str  # TOS SpaceKey auth
    store_uri: str
    session_key: str
    # 以下用于 commit 阶段
    service_id: str
    access_key: str
    secret_key: str
    session_token: str


@dataclass
class CommitResult:
    """commit_upload 返回值。"""
    store_uri: str
    success: bool


# --- Client ---

# 豆包安全参数模板（从 session 文件获取 device_id 等）
_DEFAULT_DEVICE_ID = "714003710229497"
_DEFAULT_WEB_ID = "7604137868021548590"
_DEFAULT_FP = "verify_mlcfw5f7_TPq0YmFD_NrsC_4RuQ_BJPg_M5W7i58I7wV0"
_BASE_URL = "https://www.doubao.com"


class DoubaoUploadClient:
    """封装豆包 TOS 上传三步流程（prepare / apply / commit）和下载 URL 获取。

    使用 httpx.AsyncClient，在应用启动时创建，关闭时销毁。
    """

    def __init__(
        self,
        cookies: dict[str, str],
        device_id: str = _DEFAULT_DEVICE_ID,
        web_id: str = _DEFAULT_WEB_ID,
        fp: str = _DEFAULT_FP,
    ) -> None:
        self.cookies = cookies
        self.device_id = device_id
        self.web_id = web_id
        self.fp = fp
        self._http: httpx.AsyncClient | None = None

    async def start(self) -> None:
        self._http = httpx.AsyncClient(
            cookies=self.cookies,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/148.0.0.0 Safari/537.36"
                ),
                "Content-Type": "application/json",
                "Origin": _BASE_URL,
                "Referer": f"{_BASE_URL}/chat",
            },
            timeout=httpx.Timeout(30.0, read=60.0),
        )

    async def close(self) -> None:
        if self._http:
            await self._http.aclose()
            self._http = None

    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            raise RuntimeError("DoubaoUploadClient not started; call .start() first")
        return self._http

    def _security_params(self) -> dict[str, str]:
        return {
            "aid": "582478",
            "real_aid": "582478",
            "device_id": self.device_id,
            "tea_uuid": self.device_id,
            "web_id": self.web_id,
            "device_platform": "web",
            "language": "zh",
            "region": "CN",
            "sys_region": "CN",
            "pkg_type": "release_version",
            "version_code": "20800",
            "pc_version": "2.1.7",
            "chromium_version": "148.0.7816.0",
            "client_platform": "pc_client",
            "runtime": "web",
            "runtime_version": "3.5.4",
            "samantha_web": "1",
            "use-olympus-account": "1",
            "fp": self.fp,
        }

    # ------------------------------------------------------------------
    # Step 1+2: init_upload (prepare + apply)
    # 返回浏览器直传所需的 upload_url 和 auth
    # ------------------------------------------------------------------

    async def init_upload(self, file_size: int, file_ext: str = "") -> UploadInitResult:
        """调用豆包 prepare_upload + ApplyImageUpload，返回 TOS 上传凭证。"""
        params = self._security_params()

        # --- prepare_upload ---
        prepare_url = f"{_BASE_URL}/alice/resource/prepare_upload?{urlencode(params)}"
        resp = await self.http.post(
            prepare_url,
            json={"tenant_id": "5", "scene_id": "5", "resource_type": 1},
        )
        body = resp.json()
        if body.get("code") != 0:
            raise DoubaoClientError(f"prepare_upload failed: {body.get('msg', body)}")

        data = body["data"]
        service_id = data["service_id"]
        auth_token = data["upload_auth_token"]
        access_key = auth_token["access_key"]
        secret_key = auth_token["secret_key"]
        session_token = auth_token["session_token"]

        # --- ApplyImageUpload ---
        ext_part = f".{file_ext}" if file_ext else ""
        apply_url = (
            f"{_BASE_URL}/top/v1?"
            f"Action=ApplyImageUpload&Version=2018-08-01"
            f"&ServiceId={service_id}&NeedFallback=true"
            f"&FileSize={file_size}&FileExtension={ext_part}"
            f"&s=jdnfglwfkl"
        )
        sign_headers = _aws_sign_v4("GET", apply_url, "", access_key, secret_key, session_token)
        resp = await self.http.get(apply_url, headers=sign_headers)
        body = resp.json()
        result_data = body.get("Result")
        if not result_data:
            err = body.get("ResponseMetadata", {}).get("Error", {})
            raise DoubaoClientError(
                f"ApplyImageUpload failed: {err.get('Code')} {err.get('Message') or body}"
            )

        upload_addr = result_data["UploadAddress"]
        store_info = upload_addr["StoreInfos"][0]
        store_uri = store_info["StoreUri"]
        tos_auth = store_info["Auth"]
        session_key = upload_addr["SessionKey"]
        upload_hosts = upload_addr.get("UploadHosts", [])
        tos_host = upload_hosts[0] if upload_hosts else "tos-mya2lf.vodupload.com"
        upload_url = f"https://{tos_host}/upload/v1/{store_uri}"

        log.info("init_upload OK: store_uri=%s size=%d", store_uri, file_size)
        return UploadInitResult(
            upload_url=upload_url,
            authorization=tos_auth,
            store_uri=store_uri,
            session_key=session_key,
            service_id=service_id,
            access_key=access_key,
            secret_key=secret_key,
            session_token=session_token,
        )

    # ------------------------------------------------------------------
    # Step 3: commit_upload (浏览器上传完成后调用)
    # ------------------------------------------------------------------

    async def commit_upload(
        self,
        service_id: str,
        session_key: str,
        access_key: str,
        secret_key: str,
        session_token: str,
    ) -> CommitResult:
        """调用 CommitImageUpload 确认文件上传完成。"""
        commit_url = (
            f"{_BASE_URL}/top/v1?"
            f"Action=CommitImageUpload&Version=2018-08-01"
            f"&ServiceId={service_id}"
        )
        commit_body = json.dumps({"SessionKey": session_key})
        sign_headers = _aws_sign_v4(
            "POST", commit_url, commit_body, access_key, secret_key, session_token
        )
        sign_headers["Content-Type"] = "application/json"
        resp = await self.http.post(commit_url, content=commit_body, headers=sign_headers)
        body = resp.json()
        results = body.get("Result", {}).get("Results", [])
        if not results or results[0].get("UriStatus") != 2000:
            log.error("CommitImageUpload failed: %s", body)
            raise DoubaoClientError(f"CommitImageUpload failed: {body}")

        store_uri = results[0].get("Uri", "")
        log.info("commit_upload OK: store_uri=%s", store_uri)
        return CommitResult(store_uri=store_uri, success=True)

    # ------------------------------------------------------------------
    # 下载 URL 获取
    # ------------------------------------------------------------------

    async def get_download_url(self, uri: str, expire_seconds: int = 3600) -> str:
        """获取文件的临时下载 URL。"""
        params = self._security_params()
        ext = uri.rsplit(".", 1)[-1] if "." in uri else ""
        url = f"{_BASE_URL}/alice/message/get_file_url?{urlencode(params)}"
        resp = await self.http.post(
            url,
            json={
                "uris": [uri],
                "type": "file",
                "format": ext,
                "expire_second": expire_seconds,
            },
        )
        body = resp.json()
        if body.get("code") != 0:
            raise DoubaoClientError(f"get_file_url error: {body.get('msg', body)}")
        data = body.get("data", {})
        file_urls = data.get("file_urls", []) if isinstance(data, dict) else []
        if not file_urls:
            raise DoubaoClientError("get_file_url returned no file_urls")
        return str(file_urls[0].get("main_url", ""))


# --- Factory ---

def create_doubao_client_from_session(session_file: str) -> DoubaoUploadClient:
    """从 .doubao_session.json 创建客户端（未 start，需 await client.start()）。"""
    import json as _json
    from pathlib import Path

    path = Path(session_file)
    if not path.exists():
        raise FileNotFoundError(f"Session file not found: {session_file}")
    with path.open("r", encoding="utf-8") as f:
        session = _json.load(f)

    cookies = session.get("cookies", {})
    params = session.get("params", {})
    if not cookies.get("sessionid"):
        raise DoubaoClientError(f"No sessionid in {session_file}")

    return DoubaoUploadClient(
        cookies=cookies,
        device_id=str(params.get("device_id") or _DEFAULT_DEVICE_ID),
        web_id=str(params.get("web_id") or _DEFAULT_WEB_ID),
        fp=str(params.get("fp") or _DEFAULT_FP),
    )


# --- 全局单例（应用生命周期管理） ---

_client: DoubaoUploadClient | None = None


async def get_doubao_client() -> DoubaoUploadClient:
    """FastAPI 依赖注入用。返回已 start 的全局客户端。"""
    global _client
    if _client is None:
        settings = get_settings()
        session_file = settings.doubao_session_file
        if not session_file:
            raise DoubaoClientError(
                "DOUBAO_SESSION_FILE not configured in settings"
            )
        _client = create_doubao_client_from_session(session_file)
        await _client.start()
    return _client


async def shutdown_doubao_client() -> None:
    """应用关闭时调用。"""
    global _client
    if _client is not None:
        await _client.close()
        _client = None
