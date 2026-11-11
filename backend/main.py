from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
import hashlib
import os
import re
import secrets
import sqlite3
import time

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pwdlib import PasswordHash


# ========== Project configuration ==========

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
DB_DIR = BASE_DIR / "backend" / "data"
DB_PATH = DB_DIR / "app.db"

SESSION_COOKIE = "capstone_session"
SESSION_TTL = 7 * 24 * 60 * 60  # 7 days

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


@app.get("/auth")
def auth_page():
    return FileResponse(FRONTEND_DIR / "auth.html")


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