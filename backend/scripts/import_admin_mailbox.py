#!/usr/bin/env python3
"""每分钟增量导入 admin@nyy.app 的本机 Maildir。"""

from __future__ import annotations

import asyncio
import fcntl
import os
from contextlib import contextmanager
from pathlib import Path

from app.db.session import get_session_factory
from app.services.mailbox import import_maildir, mailbox_storage_root


@contextmanager
def exclusive_import_lock(storage_root: Path):
    storage_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_path = storage_root / ".import.lock"
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(lock_path, flags, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        yield True
    finally:
        os.close(descriptor)


async def run() -> int:
    raw_maildir_path = os.getenv("MAILDIR_PATH", "").strip()
    if not raw_maildir_path:
        raise RuntimeError("必须配置 MAILDIR_PATH")
    maildir_path = Path(raw_maildir_path).expanduser()
    if not maildir_path.is_absolute():
        raise RuntimeError("MAILDIR_PATH 必须是绝对路径")
    storage_root = mailbox_storage_root()
    with exclusive_import_lock(storage_root) as acquired:
        if not acquired:
            print("已有邮箱导入任务运行，本次跳过")
            return 0
        factory = get_session_factory()
        async with factory() as db:
            result = await import_maildir(db, maildir_path, storage_root=storage_root)
    print(
        "邮箱导入完成: "
        f"扫描={result.scanned} 新增={result.imported} "
        f"重复关联={result.linked_duplicates} 已知={result.skipped_known} "
        f"超限={result.skipped_oversized} 失败={result.failed}"
    )
    return 1 if result.failed else 0


def main() -> None:
    raise SystemExit(asyncio.run(run()))


if __name__ == "__main__":
    main()
