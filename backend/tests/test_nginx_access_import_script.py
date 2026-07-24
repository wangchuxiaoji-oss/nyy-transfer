import json
import os

from scripts.import_nginx_share_access import _read_batch, _save_state


def _record(identifier: int) -> bytes:
    return json.dumps({"id": identifier}, separators=(",", ":")).encode() + b"\n"


def test_read_batch_finishes_rotated_log_before_current_log(tmp_path):
    log_path = tmp_path / "nyy_access.json"
    state_path = tmp_path / "state.json"
    log_path.write_bytes(_record(1) + _record(2) + _record(3))

    first_records, first_state = _read_batch(log_path, state_path, 1)
    assert first_records == [{"id": 1}]
    _save_state(state_path, first_state)

    os.replace(log_path, tmp_path / "nyy_access.json.1")
    log_path.write_bytes(_record(4) + _record(5))

    second_records, second_state = _read_batch(log_path, state_path, 3)
    assert second_records == [{"id": 2}, {"id": 3}]
    _save_state(state_path, second_state)

    eof_records, eof_state = _read_batch(log_path, state_path, 3)
    assert eof_records == []
    _save_state(state_path, eof_state)

    with (tmp_path / "nyy_access.json.1").open("ab") as stream:
        stream.write(_record(6))
    late_records, late_state = _read_batch(log_path, state_path, 3)
    assert late_records == [{"id": 6}]
    _save_state(state_path, late_state)

    grace_records, grace_state = _read_batch(log_path, state_path, 3)
    assert grace_records == []
    _save_state(state_path, grace_state)

    final_records, _ = _read_batch(log_path, state_path, 3)
    assert final_records == [{"id": 4}, {"id": 5}]
