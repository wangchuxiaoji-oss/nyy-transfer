"""为既有分享补充客户端播放 sidecar/index。"""

from __future__ import annotations

import argparse
import asyncio
import logging

from app.services.playback_assets import backfill_share_playback_assets


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("code", help="分享短码，例如 Y8PguC")
    parser.add_argument("--dry-run", action="store_true", help="只生成并打印计划，不上传/写库")
    parser.add_argument("--force", action="store_true", help="覆盖已有同类型 sidecar")
    parser.add_argument("--log-level", default="INFO")
    return parser.parse_args()


async def amain() -> None:
    args = parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO), format="%(levelname)s %(message)s")
    try:
        await backfill_share_playback_assets(args.code, dry_run=args.dry_run, force=args.force)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    asyncio.run(amain())
