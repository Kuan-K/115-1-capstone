import base64
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import main


AJAX_HEADERS = {"X-Requested-With": "XMLHttpRequest"}


def decode_token_claims(token: str) -> dict:
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


class StreamRoomApiTests(unittest.TestCase):
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

        self.env_patch = patch.dict(os.environ, {
            "LIVEKIT_URL": "wss://test.livekit.cloud",
            "LIVEKIT_API_KEY": "test-key",
            "LIVEKIT_API_SECRET": "test-secret-that-is-at-least-32-bytes",
        })
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

        main.initialize_database()
        with main.get_connection() as conn:
            self.host_id = conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                ("stream_host", "not-used")
            ).lastrowid
            self.viewer_id = conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                ("stream_viewer", "not-used")
            ).lastrowid

        self.host_client = self.make_authenticated_client(
            self.host_id, "host-session"
        )
        self.viewer_client = self.make_authenticated_client(
            self.viewer_id, "viewer-session"
        )
        self.guest_client = TestClient(main.app)
        self.guest_client.__enter__()
        self.addCleanup(self.guest_client.__exit__, None, None, None)

    def make_authenticated_client(self, user_id: int, session: str):
        with main.get_connection() as conn:
            conn.execute(
                """INSERT INTO sessions (token_hash, user_id, expires_at)
                   VALUES (?, ?, ?)""",
                (main.token_digest(session), user_id, int(time.time()) + 600)
            )

        client = TestClient(main.app)
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        client.cookies.set(main.SESSION_COOKIE, session)
        return client

    def create_room(self):
        return self.host_client.post(
            "/api/rooms",
            headers=AJAX_HEADERS,
            json={"title": "  Test stream  "}
        )

    def test_room_creation_requires_login(self):
        response = self.guest_client.post(
            "/api/rooms",
            headers=AJAX_HEADERS,
            json={"title": "Test stream"}
        )

        self.assertEqual(response.status_code, 401)

    def test_create_room_persists_owner_and_issues_publish_token(self):
        response = self.create_room()

        self.assertEqual(response.status_code, 201, response.text)
        room = response.json()
        self.assertEqual(room["title"], "Test stream")
        self.assertEqual(room["host_user_id"], self.host_id)
        self.assertEqual(room["status"], "created")

        with main.get_connection() as conn:
            stored = conn.execute(
                "SELECT * FROM stream_rooms WHERE id = ?",
                (room["id"],)
            ).fetchone()
        self.assertEqual(stored["host_user_id"], self.host_id)
        self.assertEqual(stored["title"], "Test stream")

        token_response = self.host_client.post(
            f"/api/rooms/{room['id']}/token",
            headers=AJAX_HEADERS
        )
        self.assertEqual(token_response.status_code, 200)
        self.assertEqual(
            token_response.json()["server_url"],
            "wss://test.livekit.cloud"
        )
        self.assertTrue(token_response.json()["token"])

        claims = decode_token_claims(token_response.json()["token"])
        self.assertEqual(claims["video"]["room"], stored["livekit_room_name"])
        self.assertTrue(claims["video"]["canPublish"])
        self.assertTrue(claims["video"]["canSubscribe"])

    def test_room_details_only_visible_to_host_or_live_viewer(self):
        created = self.create_room().json()
        details_url = f"/api/rooms/{created['id']}"

        host_details = self.host_client.get(details_url)
        self.assertEqual(host_details.status_code, 200)
        self.assertEqual(host_details.json()["role"], "host")
        self.assertEqual(
            self.viewer_client.get(details_url).status_code,
            409
        )

        self.host_client.post(
            f"/api/rooms/{created['id']}/start",
            headers=AJAX_HEADERS
        )
        viewer_details = self.viewer_client.get(details_url)
        self.assertEqual(viewer_details.status_code, 200)
        self.assertEqual(viewer_details.json()["role"], "viewer")

    def test_only_host_can_start_and_end_room(self):
        room_id = self.create_room().json()["id"]

        self.assertEqual(
            self.viewer_client.post(
                f"/api/rooms/{room_id}/start",
                headers=AJAX_HEADERS
            ).status_code,
            403
        )

        started = self.host_client.post(
            f"/api/rooms/{room_id}/start",
            headers=AJAX_HEADERS
        )
        self.assertEqual(started.status_code, 200, started.text)
        self.assertEqual(started.json()["status"], "live")

        self.assertEqual(
            self.viewer_client.post(
                f"/api/rooms/{room_id}/end",
                headers=AJAX_HEADERS
            ).status_code,
            403
        )

        ended = self.host_client.post(
            f"/api/rooms/{room_id}/end",
            headers=AJAX_HEADERS
        )
        self.assertEqual(ended.status_code, 200, ended.text)
        self.assertEqual(ended.json()["status"], "ended")

    def test_viewer_can_subscribe_only_after_stream_starts(self):
        room_id = self.create_room().json()["id"]
        token_path = f"/api/rooms/{room_id}/token"

        before_start = self.viewer_client.post(
            token_path,
            headers=AJAX_HEADERS
        )
        self.assertEqual(before_start.status_code, 409)

        self.host_client.post(
            f"/api/rooms/{room_id}/start",
            headers=AJAX_HEADERS
        )
        response = self.viewer_client.post(
            token_path,
            headers=AJAX_HEADERS
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["role"], "viewer")
        claims = decode_token_claims(response.json()["token"])
        self.assertFalse(claims["video"]["canPublish"])
        self.assertTrue(claims["video"]["canSubscribe"])

    def test_live_room_listing_requires_login_and_hides_non_live_rooms(self):
        created_room_id = self.create_room().json()["id"]

        self.assertEqual(self.guest_client.get("/api/rooms").status_code, 401)
        self.assertEqual(self.viewer_client.get("/api/rooms").json(), [])

        self.host_client.post(
            f"/api/rooms/{created_room_id}/start",
            headers=AJAX_HEADERS
        )
        rooms = self.viewer_client.get("/api/rooms").json()
        self.assertEqual([room["id"] for room in rooms], [created_room_id])
        self.assertEqual(rooms[0]["host_username"], "stream_host")

    def test_missing_livekit_configuration_does_not_create_room(self):
        with patch.dict(os.environ, {
            "LIVEKIT_URL": "",
            "LIVEKIT_API_KEY": "",
            "LIVEKIT_API_SECRET": "",
        }):
            room_response = self.create_room()
            token_response = self.host_client.post(
                f"/api/rooms/{room_response.json()['id']}/token",
                headers=AJAX_HEADERS
            )

        self.assertEqual(room_response.status_code, 201)
        self.assertEqual(token_response.status_code, 503)
        with main.get_connection() as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM stream_rooms"
            ).fetchone()[0]
        self.assertEqual(count, 1)

    def test_stream_page_and_browser_script_are_served(self):
        room_id = self.create_room().json()["id"]

        page = self.host_client.get(f"/stream/{room_id}")
        script = self.host_client.get("/static/js/stream.js")

        self.assertEqual(page.status_code, 200)
        self.assertIn("livekit-client@2.23.0", page.text)
        self.assertIn('id="screenShareBtn"', page.text)
        self.assertIn("Share screen", page.text)
        self.assertEqual(script.status_code, 200)
        self.assertIn("connectToRoom", script.text)
        self.assertIn("setScreenShareEnabled(true)", script.text)

    def test_title_validation_and_ended_room_token_rejection(self):
        invalid = self.host_client.post(
            "/api/rooms",
            headers=AJAX_HEADERS,
            json={"title": "   "}
        )
        self.assertEqual(invalid.status_code, 400)

        room_id = self.create_room().json()["id"]
        self.host_client.post(
            f"/api/rooms/{room_id}/end",
            headers=AJAX_HEADERS
        )
        rejected = self.host_client.post(
            f"/api/rooms/{room_id}/token",
            headers=AJAX_HEADERS
        )
        self.assertEqual(rejected.status_code, 409)


if __name__ == "__main__":
    unittest.main()
