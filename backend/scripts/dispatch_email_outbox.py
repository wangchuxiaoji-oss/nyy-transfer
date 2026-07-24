#!/usr/bin/env python3
"""投递因请求中断而留在 outbox 中的待发送分享邮件。"""

from __future__ import annotations

import argparse
import asyncio

from app.services.email import dispatch_pending_share_email_outbox


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=100)
    args = parser.parse_args()
    attempted, sent = asyncio.run(
        dispatch_pending_share_email_outbox(limit=args.batch_size)
    )
    print(f"扫描 {attempted} 封待发送邮件，成功投递 {sent} 封")


if __name__ == "__main__":
    main()
