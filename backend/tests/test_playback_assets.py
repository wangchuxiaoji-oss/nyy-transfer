import pytest

from app.services import playback_assets
from app.services.playback_assets import SingleObjectMedia, ensure_mp4_layout_metadata, has_ac3_audio


def box(box_type: bytes, payload_size: int) -> bytes:
    return (payload_size + 8).to_bytes(4, "big") + box_type + (b"\0" * payload_size)


@pytest.mark.asyncio
async def test_ensure_mp4_layout_metadata_recovers_tail_moov(monkeypatch):
    """metadata 缺少 moov 信息时，可从 mdat 后续 box 恢复。"""
    data = box(b"ftyp", 16) + box(b"free", 0) + box(b"mdat", 92) + box(b"moov", 32)

    async def fake_fetch_range(_url: str, start: int, end_exclusive: int) -> bytes:
        return data[start:end_exclusive]

    class FakeClient:
        async def get_download_url(self, _tos_uri: str, *, expire_seconds: int) -> str:
            assert expire_seconds == 86400
            return "https://example.test/video.mp4"

    monkeypatch.setattr(playback_assets, "fetch_range", fake_fetch_range)

    metadata, changed = await ensure_mp4_layout_metadata(
        {
            "probe_status": "ok",
            "container": "mp4",
            "is_faststart": False,
            "moov_offset": None,
            "moov_size": None,
        },
        SingleObjectMedia("tail.mp4", len(data), "tos-cn-i-test/tail.mp4", None),
        client=FakeClient(),
    )

    assert changed is True
    assert metadata["moov_offset"] == len(box(b"ftyp", 16)) + len(box(b"free", 0)) + len(box(b"mdat", 92))
    assert metadata["moov_size"] == len(box(b"moov", 32))
    assert metadata["is_faststart"] is False


def test_has_ac3_audio_excludes_eac3():
    assert has_ac3_audio({"audio_tracks": [{"codec": "ac3", "codec_tag": "ac-3"}]}) is True
    assert has_ac3_audio({"audio_tracks": [{"codec": "eac3", "codec_tag": "ec-3"}]}) is False
