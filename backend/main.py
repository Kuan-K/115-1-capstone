from contextlib import asynccontextmanager, contextmanager
from datetime import timedelta
from pathlib import Path
import hashlib
import os
import re
import secrets
import sqlite3
import time
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from dotenv import load_dotenv
from livekit import api
from pydantic import BaseModel
from pwdlib import PasswordHash


# ========== Project configuration ==========

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
DB_DIR = BASE_DIR / "backend" / "data"
DB_PATH = DB_DIR / "app.db"
load_dotenv(BASE_DIR / ".env")

SESSION_COOKIE = "capstone_session"
SESSION_TTL = 7 * 24 * 60 * 60  # 7 days
LIVEKIT_TOKEN_TTL = timedelta(minutes=10)

password_hasher = PasswordHash.recommended()


# ========== Database ==========

@contextmanager
def get_connection():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def initialize_database():
    DB_DIR.mkdir(parents=True, exist_ok=True)

    with get_connection() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            FOREIGN KEY (user_id)
                REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_user_id
            ON sessions(user_id);

        CREATE TABLE IF NOT EXISTS stream_rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            livekit_room_name TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
            host_user_id INTEGER NOT NULL,
            status TEXT NOT NULL
                CHECK(status IN ('created', 'live', 'ended')),
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            ended_at INTEGER,
            FOREIGN KEY (host_user_id)
                REFERENCES users(id) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_stream_rooms_status_created
            ON stream_rooms(status, created_at);

        CREATE INDEX IF NOT EXISTS idx_stream_rooms_host_user_id
            ON stream_rooms(host_user_id);
        """)


@asynccontextmanager
async def lifespan(app: FastAPI):
    initialize_database()
    yield


# ========== FastAPI application ==========

app = FastAPI(
    title="Capstone Live",
    lifespan=lifespan
)

app.mount(
    "/static",
    StaticFiles(directory=FRONTEND_DIR),
    name="static"
)


class Credentials(BaseModel):
    username: str
    password: str


class StreamRoomCreate(BaseModel):
    title: str


def require_ajax(request: Request):
    # Basic protection for same-origin browser form requests.
    if request.headers.get("X-Requested-With") != "XMLHttpRequest":
        raise HTTPException(
            status_code=403,
            detail="請透過網站表單操作"
        )


def token_digest(token: str) -> str:
    return hashlib.sha256(
        token.encode("utf-8")
    ).hexdigest()


def create_livekit_token(room_name: str, user: dict, can_publish: bool):
    server_url = os.getenv("LIVEKIT_URL")
    api_key = os.getenv("LIVEKIT_API_KEY")
    api_secret = os.getenv("LIVEKIT_API_SECRET")

    if not server_url or not api_key or not api_secret:
        raise HTTPException(
            503,
            "LiveKit 尚未完成伺服器端設定"
        )

    token = (
        api.AccessToken(api_key, api_secret)
        .with_identity(str(user["id"]))
        .with_name(user["username"])
        .with_ttl(LIVEKIT_TOKEN_TTL)
        .with_grants(api.VideoGrants(
            room_join=True,
            room=room_name,
            can_publish=can_publish,
            can_subscribe=True,
            can_publish_data=False,
        ))
    )

    return {
        "server_url": server_url,
        "token": token.to_jwt()
    }


def get_stream_room(room_id: int):
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM stream_rooms WHERE id = ?",
            (room_id,)
        ).fetchone()

    if row is None:
        raise HTTPException(404, "找不到直播間")

    return row


def current_user(request: Request):
    token = request.cookies.get(SESSION_COOKIE)

    if not token:
        raise HTTPException(401, "尚未登入")

    with get_connection() as conn:
        row = conn.execute("""
            SELECT users.id, users.username
            FROM sessions
            JOIN users ON sessions.user_id = users.id
            WHERE sessions.token_hash = ?
              AND sessions.expires_at > ?
        """, (
            token_digest(token),
            int(time.time())
        )).fetchone()

    if row is None:
        raise HTTPException(
            401, "登入已失效，請重新登入"
        )

    return {
        "id": row["id"],
        "username": row["username"]
    }


# ========== Website routes ==========

@app.get("/")
def home():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/stream/{room_id}")
def stream_page(room_id: int):
    return FileResponse(FRONTEND_DIR / "stream.html")




@app.get("/login")
def login_page():
    return FileResponse(FRONTEND_DIR / "login.html")


@app.get("/register")
def register_page():
    return FileResponse(FRONTEND_DIR / "register.html")


# Redirect the old /auth route to /login
@app.get("/auth")
def auth_page():
    return RedirectResponse(url="/login", status_code=302)


@app.get("/api/status")
def api_status():
    return {
        "status": "running",
        "message": "FastAPI backend is working"
    }


# ========== Register ==========

@app.post("/api/auth/register", status_code=201)
def register(
    data: Credentials,
    _=Depends(require_ajax)
):
    username = data.username.strip().lower()

    if not re.fullmatch(r"[a-z0-9_]{3,24}", username):
        raise HTTPException(
            400, "帳號限 3～24 位英文、數字或底線"
        )

    if not 8 <= len(data.password) <= 128:
        raise HTTPException(
            400, "密碼長度需在 8～128 字元之間"
        )

    hashed = password_hasher.hash(data.password)

    try:
        with get_connection() as conn:
            cursor = conn.execute(
                """INSERT INTO users
                   (username, password_hash)
                   VALUES (?, ?)""",
                (username, hashed)
            )
            user_id = cursor.lastrowid

    except sqlite3.IntegrityError:
        raise HTTPException(
            409, "此帳號已有人使用"
        )

    return {
        "id": user_id,
        "username": username,
        "message": "註冊成功，請登入"
    }


# ========== Login ==========

@app.post("/api/auth/login")
def login(
    data: Credentials,
    response: Response,
    _=Depends(require_ajax)
):
    username = data.username.strip().lower()

    with get_connection() as conn:
        row = conn.execute(
            """SELECT id, username, password_hash
               FROM users WHERE username = ?""",
            (username,)
        ).fetchone()

    if row is None or not password_hasher.verify(
        data.password, row["password_hash"]
    ):
        raise HTTPException(
            401, "帳號或密碼錯誤"
        )

    token = secrets.token_urlsafe(32)

    with get_connection() as conn:
        conn.execute(
            "DELETE FROM sessions WHERE expires_at <= ?",
            (int(time.time()),)
        )

        conn.execute(
            """INSERT INTO sessions
               (token_hash, user_id, expires_at)
               VALUES (?, ?, ?)""",
            (
                token_digest(token),
                row["id"],
                int(time.time()) + SESSION_TTL
            )
        )

    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=SESSION_TTL,
        httponly=True,
        samesite="lax",
        secure=os.getenv("COOKIE_SECURE") == "1",
        path="/"
    )

    return {
        "message": "登入成功",
        "username": row["username"]
    }


# ========== Check login status ==========

@app.get("/api/auth/me")
def me(user=Depends(current_user)):
    return user


# ========== Logout ==========

@app.post("/api/auth/logout")
def logout(
    request: Request,
    response: Response,
    _=Depends(require_ajax)
):
    token = request.cookies.get(SESSION_COOKIE)

    if token:
        with get_connection() as conn:
            conn.execute(
                """DELETE FROM sessions
                   WHERE token_hash = ?""",
                (token_digest(token),)
            )

    response.delete_cookie(
        key=SESSION_COOKIE,
        path="/"
    )

    return {"message": "已登出"}


# ========== Stream rooms ==========

@app.post("/api/rooms", status_code=201)
def create_stream_room(
    data: StreamRoomCreate,
    _=Depends(require_ajax),
    user=Depends(current_user),
):
    title = data.title.strip()

    if not 1 <= len(title) <= 100:
        raise HTTPException(
            400,
            "直播標題長度需為 1～100 字"
        )

    room_name = f"capstone-{uuid4().hex}"
    now = int(time.time())

    with get_connection() as conn:
        cursor = conn.execute(
            """INSERT INTO stream_rooms
               (livekit_room_name, title, host_user_id, status, created_at)
               VALUES (?, ?, ?, 'created', ?)""",
            (room_name, title, user["id"], now)
        )
        room_id = cursor.lastrowid

    return {
        "id": room_id,
        "title": title,
        "host_user_id": user["id"],
        "status": "created",
    }


@app.get("/api/rooms/{room_id}")
def stream_room_details(
    room_id: int,
    user=Depends(current_user),
):
    with get_connection() as conn:
        row = conn.execute("""
            SELECT r.id, r.title, r.host_user_id, u.username AS host_username,
                   r.status, r.created_at
            FROM stream_rooms AS r
            JOIN users AS u ON u.id = r.host_user_id
            WHERE r.id = ?
        """, (room_id,)).fetchone()

    if row is None:
        raise HTTPException(404, "找不到直播間")

    is_host = row["host_user_id"] == user["id"]
    if row["status"] == "ended":
        raise HTTPException(409, "直播間已結束")
    if not is_host and row["status"] != "live":
        raise HTTPException(409, "直播尚未開始")

    return {
        **dict(row),
        "role": "host" if is_host else "viewer",
    }


@app.get("/api/rooms")
def list_live_rooms(user=Depends(current_user)):
    with get_connection() as conn:
        rows = conn.execute("""
            SELECT r.id, r.title, r.host_user_id,
                   u.username AS host_username, r.status, r.created_at
            FROM stream_rooms AS r
            JOIN users AS u ON u.id = r.host_user_id
            WHERE r.status = 'live'
            ORDER BY r.created_at DESC
        """).fetchall()

    return [dict(row) for row in rows]


@app.post("/api/rooms/{room_id}/start")
def start_stream_room(
    room_id: int,
    _=Depends(require_ajax),
    user=Depends(current_user),
):
    room = get_stream_room(room_id)

    if room["host_user_id"] != user["id"]:
        raise HTTPException(403, "只有主播可以開始直播")

    if room["status"] == "ended":
        raise HTTPException(409, "已結束的直播間不能重新開始")

    if room["status"] == "created":
        with get_connection() as conn:
            cursor = conn.execute("""
                UPDATE stream_rooms
                SET status = 'live', started_at = ?
                WHERE id = ? AND status = 'created'
            """, (int(time.time()), room_id))

            if cursor.rowcount == 0:
                updated_room = conn.execute(
                    "SELECT status FROM stream_rooms WHERE id = ?",
                    (room_id,)
                ).fetchone()
                if updated_room is None:
                    raise HTTPException(404, "找不到直播間")
                if updated_room["status"] == "ended":
                    raise HTTPException(
                        409,
                        "已結束的直播間不能重新開始"
                    )

    return {"id": room_id, "status": "live"}


@app.post("/api/rooms/{room_id}/token")
def get_stream_token(
    room_id: int,
    _=Depends(require_ajax),
    user=Depends(current_user),
):
    room = get_stream_room(room_id)

    if room["status"] == "ended":
        raise HTTPException(409, "直播間已結束")

    is_host = room["host_user_id"] == user["id"]
    if not is_host and room["status"] != "live":
        raise HTTPException(409, "直播尚未開始")

    return {
        "room_id": room_id,
        "role": "host" if is_host else "viewer",
        **create_livekit_token(
            room["livekit_room_name"],
            user,
            can_publish=is_host
        ),
    }


@app.post("/api/rooms/{room_id}/end")
def end_stream_room(
    room_id: int,
    _=Depends(require_ajax),
    user=Depends(current_user),
):
    room = get_stream_room(room_id)

    if room["host_user_id"] != user["id"]:
        raise HTTPException(403, "只有主播可以結束直播")

    with get_connection() as conn:
        conn.execute("""
            UPDATE stream_rooms
            SET status = 'ended', ended_at = ?
            WHERE id = ? AND status != 'ended'
        """, (int(time.time()), room_id))

    return {"id": room_id, "status": "ended"}