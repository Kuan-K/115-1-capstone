from contextlib import contextmanager
from pathlib import Path
import secrets
import tempfile
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import main


AJAX_HEADERS = {"X-Requested-With": "XMLHttpRequest"}
WS_HEADERS = {"origin": "http://testserver"}


class LiveChatTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        db_dir = Path(self.temp_dir.name)
        self.db_dir_patch = patch.object(main, "DB_DIR", db_dir)
        self.db_path_patch = patch.object(main, "DB_PATH", db_dir / "test.db")
        self.db_dir_patch.start()
        self.db_path_patch.start()
        self.addCleanup(self.db_path_patch.stop)
        self.addCleanup(self.db_dir_patch.stop)
        self.addCleanup(self.temp_dir.cleanup)

        main.initialize_database()
        main.connection_manager.message_times.clear()
        with main.get_connection() as conn:
            self.host_id = conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                ("chat_host", "not-used")
            ).lastrowid
            self.viewer_id = conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                ("chat_viewer", "not-used")
            ).lastrowid
            self.other_viewer_id = conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                ("other_viewer", "not-used")
            ).lastrowid
            self.live_stream_id = conn.execute("""
                INSERT INTO stream_rooms
                    (livekit_room_name, title, host_user_id, status, created_at)
                VALUES (?, ?, ?, 'live', ?)
            """, ("chat-live", "Live chat test", self.host_id, int(time.time()))).lastrowid
            self.other_stream_id = conn.execute("""
                INSERT INTO stream_rooms
                    (livekit_room_name, title, host_user_id, status, created_at)
                VALUES (?, ?, ?, 'live', ?)
            """, ("other-live", "Other stream", self.host_id, int(time.time()))).lastrowid
            self.created_stream_id = conn.execute("""
                INSERT INTO stream_rooms
                    (livekit_room_name, title, host_user_id, status, created_at)
                VALUES (?, ?, ?, 'created', ?)
            """, ("not-live", "Not live yet", self.host_id, int(time.time()))).lastrowid

        self.host_token = self.create_session(
            self.host_id, secrets.token_urlsafe(32)
        )
        self.viewer_token = self.create_session(
            self.viewer_id, secrets.token_urlsafe(32)
        )
        self.other_viewer_token = self.create_session(
            self.other_viewer_id, secrets.token_urlsafe(32)
        )
        self.client = TestClient(main.app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def create_session(self, user_id: int, token: str):
        with main.get_connection() as conn:
            conn.execute(
                """INSERT INTO sessions (token_hash, user_id, expires_at)
                   VALUES (?, ?, ?)""",
                (main.token_digest(token), user_id, int(time.time()) + 600)
            )
        return token

    def client_for(self, token: str):
        self.client.cookies.set(main.SESSION_COOKIE, token)
        return self.client

    @contextmanager
    def websocket(
        self,
        token: str,
        stream_id: int,
        headers: dict | None = None,
    ):
        self.client.cookies.set(main.SESSION_COOKIE, token)
        with self.client.websocket_connect(
            f"/ws/streams/{stream_id}",
            headers=headers or WS_HEADERS,
        ) as socket:
            yield socket

    def test_history_api_requires_access_and_returns_latest_in_order(self):
        with main.get_connection() as conn:
            for index in range(55):
                conn.execute("""
                    INSERT INTO messages (stream_id, user_id, content, created_at)
                    VALUES (?, ?, ?, ?)
                """, (
                    self.live_stream_id,
                    self.viewer_id,
                    f"message-{index}",
                    int(time.time())
                ))

        path = f"/api/rooms/{self.live_stream_id}/messages"
        self.client.cookies.delete(main.SESSION_COOKIE)
        self.assertEqual(self.client.get(path).status_code, 401)
        response = self.client_for(self.viewer_token).get(f"{path}?limit=2")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            [message["content"] for message in response.json()],
            ["message-53", "message-54"]
        )
        self.assertTrue(all(
            message["username"] == "chat_viewer"
            for message in response.json()
        ))
        default_history = self.client_for(self.viewer_token).get(path).json()
        self.assertEqual(len(default_history), 50)
        self.assertEqual(default_history[0]["content"], "message-5")
        self.assertEqual(
            self.client_for(self.viewer_token).get(
                f"/api/rooms/{self.created_stream_id}/messages"
            ).status_code,
            409
        )
        self.assertEqual(
            self.client_for(self.viewer_token).get(f"{path}?limit=0").status_code,
            422
        )
        main.initialize_database()
        with main.get_connection() as conn:
            retained_user = conn.execute(
                "SELECT id FROM users WHERE id = ?",
                (self.viewer_id,)
            ).fetchone()
        self.assertIsNotNone(retained_user)

    def test_websocket_auth_origin_and_live_state_are_required(self):
        self.client.cookies.delete(main.SESSION_COOKIE)
        with self.assertRaises(WebSocketDisconnect) as guest_error:
            with self.client.websocket_connect(
                f"/ws/streams/{self.live_stream_id}",
                headers=WS_HEADERS,
            ):
                pass
        self.assertEqual(guest_error.exception.code, 4401)

        with self.assertRaises(WebSocketDisconnect) as origin_error:
            with self.websocket(
                self.viewer_token,
                self.live_stream_id,
                {"origin": "http://attacker.example"},
            ):
                pass
        self.assertEqual(origin_error.exception.code, 4403)

        with self.assertRaises(WebSocketDisconnect) as state_error:
            with self.websocket(
                self.viewer_token,
                self.created_stream_id
            ):
                pass
        self.assertEqual(state_error.exception.code, 4409)

    def test_room_broadcast_uses_server_identity_and_is_isolated(self):
        with (
            self.websocket(self.host_token, self.live_stream_id) as host_socket,
            self.websocket(self.viewer_token, self.live_stream_id) as viewer_socket,
            self.websocket(
                self.other_viewer_token,
                self.other_stream_id
            ) as other_socket,
        ):
            viewer_socket.send_json({
                "type": "chat.send",
                "content": "<script>alert(1)</script>",
                "username": "forged_user",
                "user_id": self.host_id,
            })
            host_message = host_socket.receive_json()
            viewer_message = viewer_socket.receive_json()

            self.assertEqual(host_message, viewer_message)
            self.assertEqual(host_message["type"], "chat.message")
            self.assertEqual(host_message["username"], "chat_viewer")
            self.assertEqual(host_message["user_id"], self.viewer_id)
            self.assertEqual(
                host_message["content"],
                "<script>alert(1)</script>"
            )
            self.assertEqual(host_message["stream_id"], self.live_stream_id)

            other_socket.send_json({
                "type": "chat.send",
                "content": "other room",
            })
            other_message = other_socket.receive_json()
            self.assertEqual(other_message["content"], "other room")
            self.assertEqual(other_message["stream_id"], self.other_stream_id)

        self.assertNotIn(
            self.live_stream_id,
            main.connection_manager.connections
        )
        self.assertNotIn(
            self.other_stream_id,
            main.connection_manager.connections
        )
        with main.get_connection() as conn:
            stored = conn.execute(
                "SELECT user_id, content FROM messages WHERE stream_id = ?",
                (self.live_stream_id,)
            ).fetchone()
        self.assertEqual(stored["user_id"], self.viewer_id)
        self.assertEqual(stored["content"], "<script>alert(1)</script>")

    def test_validation_rate_limit_logout_and_stream_end_cleanup(self):
        with self.websocket(self.viewer_token, self.live_stream_id) as socket:
            socket.send_json({"type": "chat.send", "content": "   "})
            self.assertEqual(
                socket.receive_json()["code"],
                "invalid_content"
            )

            socket.send_json({"type": "chat.send", "content": "hello"})
            self.assertEqual(socket.receive_json()["type"], "chat.message")
            socket.send_json({"type": "chat.send", "content": "too fast"})
            self.assertEqual(
                socket.receive_json()["code"],
                "rate_limited"
            )

            logout = self.client_for(self.viewer_token).post(
                "/api/auth/logout",
                headers=AJAX_HEADERS
            )
            self.assertEqual(logout.status_code, 200, logout.text)
            self.assertNotIn(
                self.live_stream_id,
                main.connection_manager.connections
            )
            with self.assertRaises(WebSocketDisconnect):
                socket.receive_json()

        with self.websocket(
            self.other_viewer_token,
            self.other_stream_id
        ) as expired_socket:
            with main.get_connection() as conn:
                conn.execute(
                    "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
                    (
                        int(time.time()) - 1,
                        main.token_digest(self.other_viewer_token),
                    )
                )
            expired_socket.send_json({
                "type": "chat.send",
                "content": "must not be saved",
            })
            with self.assertRaises(WebSocketDisconnect):
                expired_socket.receive_json()
            self.assertNotIn(
                self.other_stream_id,
                main.connection_manager.connections
            )
        with main.get_connection() as conn:
            expired_message_count = conn.execute(
                "SELECT COUNT(*) FROM messages WHERE stream_id = ?",
                (self.other_stream_id,)
            ).fetchone()[0]
        self.assertEqual(expired_message_count, 0)

        with self.websocket(self.host_token, self.live_stream_id) as host_socket:
            ended = self.client_for(self.host_token).post(
                f"/api/rooms/{self.live_stream_id}/end",
                headers=AJAX_HEADERS
            )
            self.assertEqual(ended.status_code, 200, ended.text)
            self.assertEqual(host_socket.receive_json()["type"], "stream.ended")
            with self.assertRaises(WebSocketDisconnect):
                host_socket.receive_json()
            self.assertNotIn(
                self.live_stream_id,
                main.connection_manager.connections
            )


if __name__ == "__main__":
    unittest.main()
