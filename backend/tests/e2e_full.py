"""Full e2e test for nyy.app - all guest features."""
import asyncio
import json
import struct
import sys
import zlib
from pathlib import Path

# Ensure app is importable
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx

API = "http://127.0.0.1:8000"
FRONTEND = "http://127.0.0.1:3000"


async def main():
    async with httpx.AsyncClient(base_url=API, timeout=30) as c:
        print("=" * 60)
        print("E2E TEST SUITE - nyy.app")
        print("=" * 60)

        # 1. Quota API
        print("\n[1] GET /api/v1/uploads/quota")
        r = await c.get("/api/v1/uploads/quota")
        assert r.status_code == 200, f"FAIL: {r.status_code}"
        q = r.json()
        assert q["limit_bytes"] == 200 * 1024 * 1024
        remaining = q["remaining_bytes"]
        print(f"    PASS - used={q['used_bytes']}, limit=200MB, remaining={remaining}")

        # 2. Single file init
        print("\n[2] POST /api/v1/uploads/init (single file)")
        r = await c.post("/api/v1/uploads/init", json={
            "file_name": "test.txt",
            "file_size": 1024,
            "file_ext": "txt",
        })
        assert r.status_code == 200, f"FAIL: {r.status_code} {r.text}"
        init = r.json()
        assert "upload_url" in init
        assert "commit_token" in init
        assert "store_uri" in init
        token_short = init["commit_token"][:20]
        url_short = init["upload_url"][:60]
        print(f"    PASS - token={token_short}...")
        print(f"    upload_url={url_short}...")

        # 3. Upload file to TOS
        print("\n[3] PUT file to TOS")
        file_data = b"Hello nyy.app test! " * 52  # ~1040 bytes
        file_data = file_data[:1024]
        crc = zlib.crc32(file_data) & 0xFFFFFFFF
        crc_hex = format(crc, "08x")

        r = await c.post(init["upload_url"], content=file_data, headers={
            "Authorization": init["authorization"],
            "Content-CRC32": crc_hex,
        })
        print(f"    TOS response: {r.status_code}")
        assert r.status_code in (200, 201), f"FAIL: {r.status_code} {r.text[:200]}"
        print("    PASS - uploaded 1024 bytes")

        # 4. Commit single file (no password)
        print("\n[4] POST /api/v1/uploads/commit (single, no password)")
        r = await c.post("/api/v1/uploads/commit", json={
            "files": [{"commit_token": init["commit_token"], "store_uri": init["store_uri"]}],
        })
        assert r.status_code == 201, f"FAIL: {r.status_code} {r.text}"
        commit = r.json()
        assert len(commit["share_code"]) == 6
        assert commit["file_count"] == 1
        share_code_1 = commit["share_code"]
        print(f"    PASS - code={share_code_1}, url={commit['share_url']}")

        # 5. Get share info
        print(f"\n[5] GET /api/v1/shares/{share_code_1}")
        r = await c.get(f"/api/v1/shares/{share_code_1}")
        assert r.status_code == 200, f"FAIL: {r.status_code}"
        info = r.json()
        assert info["code"] == share_code_1
        assert len(info["files"]) == 1
        assert info["files"][0]["file_name"] == "test.txt"
        assert info["files"][0]["file_size"] == 1024
        assert info["has_password"] is False
        print(f"    PASS - files=1, has_password=False")

        # 6. Download (no password)
        print(f"\n[6] GET /api/v1/shares/{share_code_1}/download")
        r = await c.get(f"/api/v1/shares/{share_code_1}/download")
        assert r.status_code == 200, f"FAIL: {r.status_code} {r.text}"
        dl = r.json()
        assert len(dl["files"]) == 1
        assert dl["files"][0]["download_url"].startswith("https://")
        assert dl["files"][0]["file_name"] == "test.txt"
        dl_url = dl["files"][0]["download_url"][:60]
        print(f"    PASS - download_url={dl_url}...")

        # 7. Active share limit
        print("\n[7] Active share limit test")
        r = await c.post("/api/v1/uploads/init", json={
            "file_name": "test2.txt", "file_size": 512, "file_ext": "txt",
        })
        assert r.status_code == 200
        init2 = r.json()
        file_data2 = b"x" * 512
        crc2 = format(zlib.crc32(file_data2) & 0xFFFFFFFF, "08x")
        r = await c.post(init2["upload_url"], content=file_data2, headers={
            "Authorization": init2["authorization"],
            "Content-CRC32": crc2,
        })
        assert r.status_code in (200, 201)
        r = await c.post("/api/v1/uploads/commit", json={
            "files": [{"commit_token": init2["commit_token"], "store_uri": init2["store_uri"]}],
        })
        assert r.status_code == 429, f"Expected 429, got {r.status_code}: {r.text}"
        detail = r.json()["detail"]
        print(f"    PASS - commit blocked: {detail}")

        # 8. Revoke first share
        print("\n[8] Revoke first share")
        from app.db.session import get_session_factory
        from app.models.share import Share
        from sqlalchemy import update
        from datetime import datetime, timezone
        factory = get_session_factory()
        async with factory() as db:
            await db.execute(
                update(Share).where(Share.code == share_code_1)
                .values(revoked_at=datetime.now(timezone.utc))
            )
            await db.commit()
        print(f"    Revoked {share_code_1}")

        # 9. Multi-file upload with password
        print("\n[9] Multi-file upload with password")
        files_info = [
            ("photo.jpg", b"JPEG" * 256, "jpg"),
            ("doc.pdf", b"PDF1" * 128, "pdf"),
        ]
        commit_items = []
        for fname, fdata, fext in files_info:
            r = await c.post("/api/v1/uploads/init", json={
                "file_name": fname, "file_size": len(fdata), "file_ext": fext,
            })
            assert r.status_code == 200, f"FAIL init {fname}: {r.status_code}"
            ini = r.json()
            crc_val = format(zlib.crc32(fdata) & 0xFFFFFFFF, "08x")
            r = await c.post(ini["upload_url"], content=fdata, headers={
                "Authorization": ini["authorization"],
                "Content-CRC32": crc_val,
            })
            assert r.status_code in (200, 201), f"FAIL upload {fname}: {r.status_code}"
            commit_items.append({"commit_token": ini["commit_token"], "store_uri": ini["store_uri"]})
            print(f"    uploaded {fname} ({len(fdata)} bytes)")

        r = await c.post("/api/v1/uploads/commit", json={
            "files": commit_items,
            "password": "6789",
            "expires_hours": 24,
        })
        assert r.status_code == 201, f"FAIL commit: {r.status_code} {r.text}"
        multi = r.json()
        assert multi["file_count"] == 2
        share_code_2 = multi["share_code"]
        print(f"    PASS - code={share_code_2}, file_count=2, password=6789")

        # 10. Multi-file share info
        print(f"\n[10] GET /api/v1/shares/{share_code_2}")
        r = await c.get(f"/api/v1/shares/{share_code_2}")
        assert r.status_code == 200
        info2 = r.json()
        assert len(info2["files"]) == 2
        assert info2["has_password"] is True
        assert info2["total_bytes"] == 1536
        assert info2["expires_at"] is not None
        print(f"    PASS - 2 files, has_password=True, total=1536B")

        # 11. Download blocked (password required)
        print(f"\n[11] Download without password -> 403")
        r = await c.get(f"/api/v1/shares/{share_code_2}/download")
        assert r.status_code == 403
        print(f"    PASS - blocked: {r.json()['detail']}")

        # 12. Wrong password
        print(f"\n[12] Verify wrong password -> 403")
        r = await c.post(f"/api/v1/shares/{share_code_2}/verify", json={"password": "0000"})
        assert r.status_code == 403
        print("    PASS - wrong password rejected")

        # 13. Correct password
        print(f"\n[13] Verify correct password -> download URLs")
        r = await c.post(f"/api/v1/shares/{share_code_2}/verify", json={"password": "6789"})
        assert r.status_code == 200, f"FAIL: {r.status_code} {r.text}"
        verify = r.json()
        assert len(verify["files"]) == 2
        for f in verify["files"]:
            assert f["download_url"].startswith("https://")
            print(f"      {f['file_name']} ({f['file_size']}B) -> OK")
        print("    PASS")

        # 14. Quota consumed
        print("\n[14] Quota after uploads")
        r = await c.get("/api/v1/uploads/quota")
        q2 = r.json()
        print(f"    used={q2['used_bytes']}B, remaining={q2['remaining_bytes']}B")
        assert q2["used_bytes"] > 0
        print("    PASS")

        # 15. Frontend pages
        print("\n[15] Frontend tests")
        async with httpx.AsyncClient(timeout=10) as fc:
            r = await fc.get(FRONTEND)
            assert r.status_code == 200
            print(f"    Homepage: OK (status=200, len={len(r.text)})")

            r = await fc.get(f"{FRONTEND}/{share_code_2}")
            assert r.status_code == 200
            print(f"    Share page /{share_code_2}: OK (status=200)")

            r = await fc.get(f"{FRONTEND}/ZZZZZZ")
            assert r.status_code == 200
            print("    Not found /ZZZZZZ: OK (client-side 404)")

        print("\n" + "=" * 60)
        print("ALL 15 TESTS PASSED!")
        print("=" * 60)


asyncio.run(main())
