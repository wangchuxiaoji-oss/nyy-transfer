from app.services.nginx_access_import import classify_nginx_preview, extract_share_code


def test_extract_share_code_only_accepts_public_single_segment():
    assert extract_share_code("/2FprGJ") == "2FprGJ"
    assert extract_share_code("/admin") is None
    assert extract_share_code("/api/v1/shares") is None
    assert extract_share_code("/_next/static/app.js") is None


def test_qq_url_rich_service_is_high_confidence_preview():
    result = classify_nginx_preview(
        {
            "method": "GET",
            "client_ip": "49.234.27.58",
            "user_agent": "QQUrlRichService/1.0",
            "status": 499,
        }
    )
    assert result == ("preview_bot", "high", "qq_preview")


def test_weak_embedded_browser_ua_is_not_preview_by_itself():
    assert classify_nginx_preview(
        {
            "method": "GET",
            "client_ip": "8.8.8.8",
            "user_agent": "Mozilla/5.0 MicroMessenger/8.0 T7/13.2",
            "status": 499,
        }
    ) is None
