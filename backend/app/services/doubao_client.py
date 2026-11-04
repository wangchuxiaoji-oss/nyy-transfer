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
import os
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlparse

import httpx

from app.core.config import get_settings

log = logging.getLogger(__name__)
_SESSION_FILE_LOCK = threading.RLock()


def _secure_session_directory(path: Path) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)


def _write_session_data(path: Path, data: dict) -> None:
    _secure_session_directory(path)
    file_descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(file_descriptor, 0o600)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as temporary_file:
            file_descriptor = -1
            json.dump(data, temporary_file, ensure_ascii=False, indent=2)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, path)
        os.chmod(path, 0o600)
        directory_descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if file_descriptor >= 0:
            os.close(file_descriptor)
        temporary_path.unlink(missing_ok=True)


def _load_session_data(path: Path, *, repair: bool = True) -> dict:
    text = path.read_text("utf-8")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        start = len(text) - len(text.lstrip())
        data, end = decoder.raw_decode(text, start)
        remainder = text[end:].strip()
        if not isinstance(data, dict) or not remainder or set(remainder) != {"}"}:
            raise
        log.warning("repairing trailing braces in doubao session file: %s", path)
        if repair:
            _write_session_data(path, data)
    if not isinstance(data, dict):
        raise DoubaoClientError(f"Invalid session data in {path}")
    return data


def load_doubao_session_data(session_file: str) -> dict:
    path = Path(session_file)
    if not path.exists():
        raise FileNotFoundError(f"Session file not found: {session_file}")
    with _SESSION_FILE_LOCK:
        _secure_session_directory(path)
        os.chmod(path, 0o600)
        return _load_session_data(path)

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
    now = datetime.now(UTC)
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
class UploadAuthResult:
    """豆包上传授权, 用于 ApplyImageUpload / CommitImageUpload 签名。"""

    service_id: str
    access_key: str
    secret_key: str
    session_token: str
    current_time: str
    expired_time: str


@dataclass
class UploadInitResult:
    """init_upload 返回值，前端用来直传 TOS。"""
    upload_url: str
    authorization: str  # TOS SpaceKey auth（Init/UploadPart/Merge 三步通用）
    store_uri: str
    session_key: str
    tos_host: str  # 裸 host，multipart 拼 ?uploads/?partNumber/?uploadID 用
    # 以下用于 commit 阶段
    service_id: str
    access_key: str
    secret_key: str
    session_token: str
    current_time: str = ""
    expired_time: str = ""
    raw_result: dict | None = None


@dataclass
class CommitResult:
    """commit_upload 返回值。"""
    store_uri: str
    success: bool
    uri_status: int = 2000


@dataclass(frozen=True)
class DownloadUrlResult:
    """豆包返回的主、备临时下载地址。"""

    main_url: str
    backup_url: str = ""


# --- Client ---

# 豆包安全参数模板（从 session 文件获取 device_id 等）
_DEFAULT_DEVICE_ID = "714003710229497"
_DEFAULT_WEB_ID = "7604137868021548590"
_DEFAULT_FP = "verify_mlcfw5f7_TPq0YmFD_NrsC_4RuQ_BJPg_M5W7i58I7wV0"
_BASE_URL = "https://www.doubao.com"
_IMAGEX_API_URL = "https://imagex.volcengineapi.com/"
_DOUBAO_IMAGE_EXTENSIONS = frozenset({
    "avif", "bmp", "dng", "gif", "heic", "heif", "jpeg", "jpg", "png", "webp",
})


def record_doubao_session_status(session_file: str | None, **updates: object) -> None:
    """把豆包 session 探活状态写回本地 session 文件。"""
    if not session_file or not updates:
        return
    path = Path(session_file)
    if not path.exists():
        return
    try:
        with _SESSION_FILE_LOCK:
            data = _load_session_data(path)
            status = data.get("nyy_status")
            if not isinstance(status, dict):
                status = {}
            status.update(updates)
            data["nyy_status"] = status
            _write_session_data(path, data)
    except Exception as exc:
        log.warning("record doubao session status failed: %s", exc)


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
        session_file: str | None = None,
    ) -> None:
        self.cookies = cookies
        self.device_id = device_id
        self.web_id = web_id
        self.fp = fp
        self.session_file = session_file
        self._http: httpx.AsyncClient | None = None
        self._last_login_heartbeat_at = 0.0

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

    async def refresh_login_heartbeat(
        self,
        *,
        force: bool = False,
        min_interval_seconds: int = 600,
    ) -> bool:
        """刷新豆包 Web 登录态活跃时间，不刷新上传 STS。"""
        now = time.monotonic()
        if not force and now - self._last_login_heartbeat_at < min_interval_seconds:
            return False
        started_at = time.time()
        params = {
            "aid": "497858",
            "scene": "polling",
            "device_platform": "web",
            "passport_jssdk_version": "1.0.0",
        }
        try:
            resp = await self.http.get(f"{_BASE_URL}/passport/token/beat/web/?{urlencode(params)}")
            try:
                body = resp.json()
            except Exception as exc:
                raise DoubaoClientError(f"token_beat 响应非 JSON: {resp.text[:200]}") from exc
            data = body.get("data") if isinstance(body, dict) else None
            if resp.status_code != 200 or not isinstance(data, dict) or data.get("error_code") != 0:
                raise DoubaoClientError(f"token_beat failed: {body}")
        except Exception as exc:
            record_doubao_session_status(
                self.session_file,
                last_heartbeat_at=started_at,
                last_heartbeat_error=str(exc)[:300],
            )
            raise
        self._last_login_heartbeat_at = now
        record_doubao_session_status(
            self.session_file,
            last_heartbeat_at=started_at,
            last_heartbeat_success_at=time.time(),
            last_heartbeat_error="",
        )
        # 心跳成功后把更新的 cookies 持久化到文件，防止重启丢失
        await self._persist_cookies()
        return True

    async def _persist_cookies(self) -> None:
        """将 httpx 内部更新后的 cookies 写回 .doubao_session.json。"""
        if not self.session_file or not self._http:
            return
        path = Path(self.session_file)
        if not path.exists():
            return
        try:
            with _SESSION_FILE_LOCK:
                data = _load_session_data(path)
                new_cookies = {}
                for cookie in self._http.cookies.jar:
                    new_cookies[cookie.name] = cookie.value
                if new_cookies:
                    data["cookies"] = new_cookies
                    data["timestamp"] = int(time.time())
                    data["source"] = "heartbeat+persist"
                    _write_session_data(path, data)
                    log.debug("persisted %d cookies to %s", len(new_cookies), path)
        except Exception as exc:
            log.warning("persist_cookies failed: %s", exc)

    async def _prepare_upload_auth(self) -> UploadAuthResult:
        """获取一组新的豆包上传 STS 授权。"""
        try:
            await self.refresh_login_heartbeat()
        except Exception as exc:
            log.warning("doubao login heartbeat failed before prepare_upload: %s", exc)

        started_at = time.time()
        params = self._security_params()
        prepare_url = f"{_BASE_URL}/alice/resource/prepare_upload?{urlencode(params)}"
        try:
            resp = await self.http.post(
                prepare_url,
                json={"tenant_id": "5", "scene_id": "5", "resource_type": 1},
            )
            body = resp.json()
            if body.get("code") != 0:
                raise DoubaoClientError(f"prepare_upload failed: {body.get('msg', body)}")
            data = body["data"]
            auth_token = data["upload_auth_token"]
        except Exception as exc:
            record_doubao_session_status(
                self.session_file,
                last_probe_at=started_at,
                last_probe_error=str(exc)[:300],
            )
            raise

        record_doubao_session_status(
            self.session_file,
            last_probe_at=started_at,
            last_probe_success_at=time.time(),
            last_probe_error="",
        )
        return UploadAuthResult(
            service_id=data["service_id"],
            access_key=auth_token["access_key"],
            secret_key=auth_token["secret_key"],
            session_token=auth_token["session_token"],
            current_time=auth_token["current_time"],
            expired_time=auth_token["expired_time"],
        )

    # ------------------------------------------------------------------
    # Step 1+2: init_upload (prepare + apply)
    # 返回浏览器直传所需的 upload_url 和 auth
    # ------------------------------------------------------------------

    async def init_upload(
        self,
        file_size: int,
        file_ext: str = "",
        *,
        store_key: str = "",
    ) -> UploadInitResult:
        """调用豆包 prepare_upload + ApplyImageUpload，返回 TOS 上传凭证。"""
        auth = await self._prepare_upload_auth()

        # --- ApplyImageUpload ---
        apply_params = {
            "Action": "ApplyImageUpload",
            "Version": "2018-08-01",
            "ServiceId": auth.service_id,
            "NeedFallback": "true",
            "FileSize": str(file_size),
            "s": "jdnfglwfkl",
        }
        if file_ext:
            apply_params["FileExtension"] = f".{file_ext}"
        if store_key:
            apply_params["StoreKeys"] = store_key
        apply_url = f"{_BASE_URL}/top/v1?{urlencode(apply_params)}"
        sign_headers = _aws_sign_v4(
            "GET",
            apply_url,
            "",
            auth.access_key,
            auth.secret_key,
            auth.session_token,
        )
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
            tos_host=tos_host,
            service_id=auth.service_id,
            access_key=auth.access_key,
            secret_key=auth.secret_key,
            session_token=auth.session_token,
            current_time=auth.current_time,
            expired_time=auth.expired_time,
            raw_result=result_data,
        )

    # ------------------------------------------------------------------
    # Step 3: multipart 协议（init_multipart / merge_multipart）
    # ------------------------------------------------------------------

    async def init_multipart(
        self,
        store_uri: str,
        tos_auth: str,
        tos_host: str,
        is_large_file: bool,
    ) -> str:
        """发起 multipart 上传（PUT ?uploads），返回 uploadID。

        is_large_file（>1GB）时需带 X-Storage-Mode: gateway 头。
        """
        url = f"https://{tos_host}/{store_uri}?uploads"
        headers = {"Authorization": tos_auth}
        if is_large_file:
            headers["X-Storage-Mode"] = "gateway"
        resp = await self.http.put(url, headers=headers)
        try:
            body = resp.json()
        except Exception as exc:
            raise DoubaoClientError(f"init_multipart 响应非 JSON: {resp.text[:200]}") from exc
        upload_id = (body.get("payload") or {}).get("uploadID")
        if resp.status_code != 200 or not upload_id:
            raise DoubaoClientError(f"init_multipart 失败: {resp.status_code} {resp.text[:200]}")
        log.info("init_multipart OK: store_uri=%s upload_id=%s", store_uri, upload_id)
        return upload_id

    async def merge_multipart(
        self,
        store_uri: str,
        tos_auth: str,
        tos_host: str,
        upload_id: str,
        crc_list: list[str],
        is_large_file: bool,
    ) -> None:
        """合并 multipart（PUT ?uploadID），body 为纯文本 "0:crc,1:crc,..."。

        注意：merge body 索引始终从 0 连续，与上传时 partNumber 是否偏移无关。
        body 不是 JSON（发 JSON 会得到 InvalidMergeParts）。
        """
        if not crc_list:
            raise DoubaoClientError("merge_multipart: crc_list 为空")
        merge_body = ",".join(f"{i}:{crc}" for i, crc in enumerate(crc_list))
        url = f"https://{tos_host}/{store_uri}?uploadID={upload_id}"
        headers = {"Authorization": tos_auth}
        if is_large_file:
            headers["X-Storage-Mode"] = "gateway"
        resp = await self.http.put(url, content=merge_body.encode(), headers=headers)
        ok = resp.status_code == 200 and '"success":0' in resp.text.replace(" ", "")
        if not ok:
            raise DoubaoClientError(f"merge_multipart 失败: {resp.status_code} {resp.text[:300]}")
        log.info("merge_multipart OK: store_uri=%s parts=%d", store_uri, len(crc_list))

    # ------------------------------------------------------------------
    # Step 4: commit_upload (浏览器上传完成后调用)
    # ------------------------------------------------------------------

    async def commit_upload(
        self,
        service_id: str,
        session_key: str,
        access_key: str,
        secret_key: str,
        session_token: str,
        *,
        success_oids: list[str] | None = None,
        refresh_auth: bool = True,
    ) -> CommitResult:
        """调用 CommitImageUpload 确认文件上传完成。"""
        # Redis 中的 commit_token 可保留 72 小时, 但豆包 STS 通常更早过期;
        # CommitImageUpload 只依赖旧 SessionKey, 签名凭证必须提交前刷新。
        if refresh_auth:
            auth = await self._prepare_upload_auth()
            service_id = auth.service_id
            access_key = auth.access_key
            secret_key = auth.secret_key
            session_token = auth.session_token

        commit_url = (
            f"{_BASE_URL}/top/v1?"
            f"Action=CommitImageUpload&Version=2018-08-01"
            f"&ServiceId={service_id}"
        )
        commit_payload: dict[str, object] = {"SessionKey": session_key}
        if success_oids:
            commit_payload["SuccessOids"] = success_oids
        commit_body = json.dumps(commit_payload, separators=(",", ":"))
        sign_headers = _aws_sign_v4(
            "POST", commit_url, commit_body, access_key, secret_key, session_token
        )
        sign_headers["Content-Type"] = "application/json"
        resp = await self.http.post(commit_url, content=commit_body, headers=sign_headers)
        body = resp.json()
        results = body.get("Result", {}).get("Results", [])
        if not results:
            log.error("CommitImageUpload failed: no results, body=%s", body)
            raise DoubaoClientError(f"CommitImageUpload failed: {body}")
        status = results[0].get("UriStatus")
        if status != 2000 and status != 2001:
            # 2000=处理成功, 2001=文件已存在但非图片(正常的非图片文件上传)
            log.error("CommitImageUpload failed: status=%s body=%s", status, body)
            raise DoubaoClientError(f"CommitImageUpload failed: {body}")

        store_uri = results[0].get("Uri", "")
        log.info("commit_upload OK: store_uri=%s", store_uri)
        return CommitResult(store_uri=store_uri, success=True, uri_status=status)

    async def delete_upload_files(self, store_uris: list[str]) -> set[str]:
        """通过豆包资源接口删除对象，必要时回退 ImageX 管理 API。"""
        unique_uris = list(dict.fromkeys(uri for uri in store_uris if uri))
        if not unique_uris:
            return set()

        confirmed: set[str] = set()
        for start in range(0, len(unique_uris), 100):
            batch = unique_uris[start:start + 100]
            delete_url = (
                f"{_BASE_URL}/alice/resource/delete_files?"
                f"{urlencode(self._security_params())}"
            )
            resource_uris = [
                {
                    "uri": uri,
                    "data_type": "image"
                    if uri.rsplit(".", 1)[-1].lower() in _DOUBAO_IMAGE_EXTENSIONS
                    else "file",
                }
                for uri in batch
            ]
            response = await self.http.post(delete_url, json={"uris": resource_uris})
            try:
                body = response.json()
            except Exception as exc:
                raise DoubaoClientError(
                    f"豆包资源删除响应非 JSON: {response.text[:300]}"
                ) from exc
            if response.status_code == 200 and body.get("code") == 0:
                confirmed.update(batch)
                continue

            settings = get_settings()
            required_credentials = {
                "IMAGEX_ACCESS_KEY": settings.imagex_access_key,
                "IMAGEX_SECRET_KEY": settings.imagex_secret_key,
                "IMAGEX_SERVICE_ID": settings.imagex_service_id,
            }
            missing_credentials = [
                name for name, value in required_credentials.items() if not value
            ]
            if missing_credentials:
                raise DoubaoClientError(
                    f"豆包资源删除失败: {body}; ImageX 管理回退缺少: "
                    + ", ".join(missing_credentials)
                )

            delete_url = (
                f"{_IMAGEX_API_URL}?"
                f"Action=DeleteImageUploadFiles&Version=2018-08-01"
                f"&ServiceId={settings.imagex_service_id}"
            )
            delete_body = json.dumps({"StoreUris": batch}, separators=(",", ":"))
            sign_headers = _aws_sign_v4(
                "POST",
                delete_url,
                delete_body,
                settings.imagex_access_key,
                settings.imagex_secret_key,
                settings.imagex_session_token,
            )
            sign_headers["Content-Type"] = "application/json"
            response = await self.http.post(
                delete_url,
                content=delete_body,
                headers=sign_headers,
            )
            try:
                body = response.json()
            except Exception as exc:
                raise DoubaoClientError(
                    f"DeleteImageUploadFiles 响应非 JSON: {response.text[:300]}"
                ) from exc
            response_error = body.get("ResponseMetadata", {}).get("Error")
            if response.status_code != 200 or response_error:
                raise DoubaoClientError(f"DeleteImageUploadFiles failed: {body}")
            result = body.get("Result", {})
            deleted = set(result.get("DeletedFiles") or [])
            batch_confirmed = deleted & set(batch)
            missing = set(batch) - batch_confirmed
            if missing:
                raise DoubaoClientError(
                    f"DeleteImageUploadFiles 未确认 {len(missing)} 个对象: {sorted(missing)[:3]}"
                )
            confirmed.update(batch_confirmed)
        return confirmed

    # ------------------------------------------------------------------
    # 下载 URL 获取
    # ------------------------------------------------------------------

    async def get_download_urls(self, uri: str, expire_seconds: int = 3600) -> DownloadUrlResult:
        """获取文件的主、备临时下载 URL。"""
        return (await self.get_download_urls_batch([uri], expire_seconds=expire_seconds))[uri]

    async def get_download_urls_batch(
        self,
        uris: list[str],
        expire_seconds: int = 3600,
    ) -> dict[str, DownloadUrlResult]:
        """批量获取文件临时地址，按扩展名分组以匹配豆包接口约束。"""
        unique_uris = list(dict.fromkeys(uri for uri in uris if uri))
        if not unique_uris:
            return {}

        params = self._security_params()
        url = f"{_BASE_URL}/alice/message/get_file_url?{urlencode(params)}"
        grouped: dict[str, list[str]] = {}
        for uri in unique_uris:
            extension = uri.rsplit(".", 1)[-1] if "." in uri else ""
            grouped.setdefault(extension, []).append(uri)

        results: dict[str, DownloadUrlResult] = {}
        for extension, extension_uris in grouped.items():
            for start in range(0, len(extension_uris), 100):
                batch = extension_uris[start:start + 100]
                resp = await self.http.post(
                    url,
                    json={
                        "uris": batch,
                        "type": "file",
                        "format": extension,
                        "expire_second": expire_seconds,
                    },
                )
                body = resp.json()
                if body.get("code") != 0:
                    raise DoubaoClientError(f"get_file_url error: {body.get('msg', body)}")
                data = body.get("data", {})
                file_urls = data.get("file_urls", []) if isinstance(data, dict) else []
                if len(file_urls) != len(batch):
                    raise DoubaoClientError(
                        f"get_file_url returned {len(file_urls)} URLs for {len(batch)} files"
                    )
                for uri, item in zip(batch, file_urls, strict=True):
                    main_url = str(item.get("main_url") or item.get("back_url") or "")
                    backup_url = str(item.get("back_url") or "")
                    if not main_url:
                        raise DoubaoClientError("get_file_url returned an empty URL")
                    if backup_url == main_url:
                        backup_url = ""
                    results[uri] = DownloadUrlResult(main_url=main_url, backup_url=backup_url)
        return results

    async def get_download_url(self, uri: str, expire_seconds: int = 3600) -> str:
        """获取文件的主临时下载 URL。"""
        return (await self.get_download_urls(uri, expire_seconds=expire_seconds)).main_url


# --- Factory ---

def create_doubao_client_from_session(session_file: str) -> DoubaoUploadClient:
    """从 .doubao_session.json 创建客户端（未 start，需 await client.start()）。"""
    path = Path(session_file)
    session = load_doubao_session_data(session_file)

    cookies = session.get("cookies", {})
    params = session.get("params", {})
    if not cookies.get("sessionid"):
        raise DoubaoClientError(f"No sessionid in {session_file}")

    return DoubaoUploadClient(
        cookies=cookies,
        device_id=str(params.get("device_id") or _DEFAULT_DEVICE_ID),
        web_id=str(params.get("web_id") or _DEFAULT_WEB_ID),
        fp=str(params.get("fp") or _DEFAULT_FP),
        session_file=str(path),
    )


def _same_session_path(left: str | None, right: str | None) -> bool:
    if not left or not right:
        return False
    try:
        return Path(left).expanduser().resolve() == Path(right).expanduser().resolve()
    except Exception:
        return left == right


def _download_fallback_session_files() -> list[str]:
    settings = get_settings()
    candidates: list[str] = []

    configured = settings.doubao_download_fallback_session_files.replace("\n", ",")
    for raw_path in configured.split(","):
        path = raw_path.strip()
        if path:
            candidates.append(path)

    test_b_file = settings.project_root / ".doubao_session_test_b.json"
    if test_b_file.exists():
        candidates.append(str(test_b_file))

    unique: list[str] = []
    for path in candidates:
        if _same_session_path(path, settings.doubao_session_file):
            continue
        if not Path(path).expanduser().exists():
            continue
        if any(_same_session_path(path, existing) for existing in unique):
            continue
        unique.append(path)
    return unique


class DoubaoDownloadUrlResolver:
    """下载签名 URL resolver；生产 session 失败时尝试备用 session。"""

    def __init__(self) -> None:
        self._primary_client: DoubaoUploadClient | None = None
        self._fallback_clients: dict[str, DoubaoUploadClient] = {}
        self._failed_labels: set[str] = set()

    async def close(self) -> None:
        for client in self._fallback_clients.values():
            await client.close()
        self._fallback_clients.clear()

    async def _get_primary_client(self) -> DoubaoUploadClient:
        if self._primary_client is None:
            self._primary_client = await get_doubao_client()
        return self._primary_client

    async def _get_fallback_client(self, session_file: str) -> DoubaoUploadClient:
        client = self._fallback_clients.get(session_file)
        if client is None:
            client = create_doubao_client_from_session(session_file)
            await client.start()
            self._fallback_clients[session_file] = client
        return client

    async def get_download_url(self, uri: str, expire_seconds: int = 3600) -> str:
        errors: list[str] = []
        if "primary" not in self._failed_labels:
            try:
                client = await self._get_primary_client()
                return await client.get_download_url(uri, expire_seconds=expire_seconds)
            except Exception as exc:
                self._failed_labels.add("primary")
                errors.append(f"primary: {exc}")
                log.warning("doubao primary download url failed for %s: %s", uri, exc)

        for session_file in _download_fallback_session_files():
            label = f"fallback:{session_file}"
            if label in self._failed_labels:
                continue
            try:
                client = await self._get_fallback_client(session_file)
                url = await client.get_download_url(uri, expire_seconds=expire_seconds)
                log.info("doubao fallback download url OK for %s via %s", uri, Path(session_file).name)
                return url
            except Exception as exc:
                self._failed_labels.add(label)
                errors.append(f"{Path(session_file).name}: {exc}")
                log.warning("doubao fallback download url failed for %s via %s: %s", uri, session_file, exc)

        detail = "; ".join(errors) if errors else "no available doubao session"
        raise DoubaoClientError(f"get_download_url failed for all sessions: {detail}")

    async def get_download_urls(self, uri: str, expire_seconds: int = 3600) -> DownloadUrlResult:
        errors: list[str] = []
        if "primary" not in self._failed_labels:
            try:
                client = await self._get_primary_client()
                return await client.get_download_urls(uri, expire_seconds=expire_seconds)
            except Exception as exc:
                self._failed_labels.add("primary")
                errors.append(f"primary: {exc}")
                log.warning("doubao primary download urls failed for %s: %s", uri, exc)

        for session_file in _download_fallback_session_files():
            label = f"fallback:{session_file}"
            if label in self._failed_labels:
                continue
            try:
                client = await self._get_fallback_client(session_file)
                urls = await client.get_download_urls(uri, expire_seconds=expire_seconds)
                log.info("doubao fallback download urls OK for %s via %s", uri, Path(session_file).name)
                return urls
            except Exception as exc:
                self._failed_labels.add(label)
                errors.append(f"{Path(session_file).name}: {exc}")
                log.warning("doubao fallback download urls failed for %s via %s: %s", uri, session_file, exc)

        detail = "; ".join(errors) if errors else "no available doubao session"
        raise DoubaoClientError(f"get_download_urls failed for all sessions: {detail}")

    async def get_download_urls_batch(
        self,
        uris: list[str],
        expire_seconds: int = 3600,
    ) -> dict[str, DownloadUrlResult]:
        """批量签名；任一会话失败时整批切换到备用会话。"""
        errors: list[str] = []
        if "primary" not in self._failed_labels:
            try:
                client = await self._get_primary_client()
                return await client.get_download_urls_batch(uris, expire_seconds=expire_seconds)
            except Exception as exc:
                message = str(exc)
                object_specific_error = "returned" in message or "get_file_url error" in message
                if len(uris) == 1 and not object_specific_error:
                    self._failed_labels.add("primary")
                errors.append(f"primary: {exc}")
                log.warning("doubao primary batch download urls failed: %s", exc)

        for session_file in _download_fallback_session_files():
            label = f"fallback:{session_file}"
            if label in self._failed_labels:
                continue
            try:
                client = await self._get_fallback_client(session_file)
                urls = await client.get_download_urls_batch(uris, expire_seconds=expire_seconds)
                log.info("doubao fallback batch download urls OK via %s", Path(session_file).name)
                return urls
            except Exception as exc:
                self._failed_labels.add(label)
                errors.append(f"{Path(session_file).name}: {exc}")
                log.warning("doubao fallback batch download urls failed via %s: %s", session_file, exc)

        detail = "; ".join(errors) if errors else "no available doubao session"
        raise DoubaoClientError(f"get_download_urls_batch failed for all sessions: {detail}")


async def get_doubao_download_url(uri: str, expire_seconds: int = 3600) -> str:
    resolver = DoubaoDownloadUrlResolver()
    try:
        return await resolver.get_download_url(uri, expire_seconds=expire_seconds)
    finally:
        await resolver.close()


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
