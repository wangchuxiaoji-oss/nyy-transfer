"""CORS spike：验证浏览器能不能直传豆包 TOS。

启动：
  cd E:\\dev\\nyy
  .\\.venv\\Scripts\\python.exe -m pip install aiohttp  # spike 需要
  .\\.venv\\Scripts\\python.exe scripts\\cors_spike_server.py \\
      --session-file E:\\dev\\DoubaoChatAPI\\.doubao_session.json --port 9290

然后浏览器打开 file:///E:/dev/nyy/scripts/cors_spike.html
点按钮，看输出（同时打开 DevTools Network 面板看 OPTIONS 预检与 POST 状态）。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOUBAO_ROOT = ROOT.parent / "doubao-file-station"
if str(DOUBAO_ROOT) not in sys.path:
    sys.path.insert(0, str(DOUBAO_ROOT))

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from urllib.parse import urlencode

from doubao_file_station.client import DoubaoFileStationClient
from doubao_file_station.signing import aws_sign_v4


app = FastAPI(title="nyy CORS spike", version="0.0.1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

CLIENT: DoubaoFileStationClient | None = None


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/sign")
async def sign(file_size: int = 8, file_ext: str = "bin") -> dict:
    """复刻 client.upload_file_from_fileobj 前半段，返回浏览器需要的 PUT 上下文。

    返回字段：
      upload_url             浏览器要打的 TOS 端点
      authorization          浏览器请求需要带的 Authorization 头
      service_id, session_key, access_key, secret_key, session_token
                             调 CommitImageUpload 用，spike 阶段一并返回方便前端调试
      file_size              用于前端构造请求体
    """

    if CLIENT is None:
        raise HTTPException(500, "client not initialized")

    params = CLIENT._security_params()  # type: ignore[attr-defined]
    base = CLIENT.base_url

    prepare_url = f"{base}/alice/resource/prepare_upload?{urlencode(params)}"
    async with CLIENT.session.post(
        prepare_url, json={"tenant_id": "5", "scene_id": "5", "resource_type": 1}
    ) as resp:
        body = await resp.json()
    if body.get("code") != 0:
        raise HTTPException(502, f"prepare_upload failed: {body}")

    data = body["data"]
    service_id = data["service_id"]
    auth_token = data["upload_auth_token"]
    access_key = auth_token["access_key"]
    secret_key = auth_token["secret_key"]
    session_token = auth_token["session_token"]

    ext = f".{file_ext}" if file_ext else ""
    apply_url = (
        f"{base}/top/v1?Action=ApplyImageUpload&Version=2018-08-01"
        f"&ServiceId={service_id}&NeedFallback=true"
        f"&FileSize={file_size}&FileExtension={ext}&s=jdnfglwfkl"
    )
    sign_headers = aws_sign_v4("GET", apply_url, "", access_key, secret_key, session_token)
    async with CLIENT.session.get(apply_url, headers=sign_headers) as resp:
        body = await resp.json()
    result = body.get("Result")
    if not result:
        raise HTTPException(502, f"ApplyImageUpload failed: {body}")

    upload_addr = result["UploadAddress"]
    store_info = upload_addr["StoreInfos"][0]
    store_uri = store_info["StoreUri"]
    tos_auth = store_info["Auth"]
    session_key = upload_addr["SessionKey"]
    upload_hosts = upload_addr.get("UploadHosts", [])
    tos_host = upload_hosts[0] if upload_hosts else "tos-mya2lf.vodupload.com"
    upload_url = f"https://{tos_host}/upload/v1/{store_uri}"

    return {
        "upload_url": upload_url,
        "authorization": tos_auth,
        "store_uri": store_uri,
        "session_key": session_key,
        "service_id": service_id,
        "file_size": file_size,
        # 注意：access_key / secret_key / session_token 是 doubao 的临时凭证，
        # spike 期可暴露给本地浏览器用于调用 CommitImageUpload；正式版本不会下发到前端。
        "access_key": access_key,
        "secret_key": secret_key,
        "session_token": session_token,
    }


@app.on_event("startup")
async def _startup() -> None:
    global CLIENT
    args = APP_ARGS
    CLIENT = await DoubaoFileStationClient.from_session(args.session_file).__aenter__()


@app.on_event("shutdown")
async def _shutdown() -> None:
    if CLIENT is not None:
        await CLIENT.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session-file", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9290)
    args = parser.parse_args()
    global APP_ARGS
    APP_ARGS = args
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


APP_ARGS = None  # 由 main() 注入

if __name__ == "__main__":
    main()
