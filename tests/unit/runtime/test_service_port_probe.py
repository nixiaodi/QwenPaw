from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


def test_posix_probe_can_reuse_closed_connections_but_checks_bind(monkeypatch):
    from qwenpaw.service import manager

    socket = MagicMock()
    monkeypatch.setattr(manager.socket, "socket", MagicMock(return_value=socket))
    monkeypatch.setattr("sys.platform", "linux")
    manager.assert_port_available(SimpleNamespace(host="127.0.0.1", port=18089))
    probe=socket.__enter__.return_value
    probe.setsockopt.assert_called_once_with(manager.socket.SOL_SOCKET, manager.socket.SO_REUSEADDR, 1)
    probe.bind.assert_called_once_with(("127.0.0.1",18089))


def test_port_probe_still_rejects_an_active_listener(monkeypatch):
    from qwenpaw.service import manager

    socket=MagicMock()
    socket.__enter__.return_value.bind.side_effect=OSError("in use")
    monkeypatch.setattr(manager.socket,"socket",MagicMock(return_value=socket))
    with pytest.raises(manager.ServiceError):
        manager.assert_port_available(SimpleNamespace(host="127.0.0.1",port=18089))


def test_windows_port_probe_does_not_enable_address_reuse(monkeypatch):
    from qwenpaw.service import manager

    socket=MagicMock()
    monkeypatch.setattr(manager.socket,"socket",MagicMock(return_value=socket))
    monkeypatch.setattr("sys.platform","win32")
    manager.assert_port_available(SimpleNamespace(host="127.0.0.1",port=18089))
    socket.__enter__.return_value.setsockopt.assert_not_called()
