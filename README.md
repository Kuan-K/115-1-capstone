# 115-1-capstone

A starter project for a live-streaming application, with a FastAPI backend and
a static frontend.

## Run locally

From the project root, install the dependencies and start the development server:

```powershell
.\.venv\Scripts\python.exe -m pip install "fastapi[standard]"
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload
```

Open <http://127.0.0.1:8000> in a browser. The backend health endpoint is
available at <http://127.0.0.1:8000/api/health>.

## Project structure

- `backend/main.py`: FastAPI application, session authentication, SQLite schema,
  stream APIs, and real-time chat WebSocket.
- `frontend/`: Static HTML, CSS, and JavaScript served by the backend.
- `requirements.txt`: Python dependencies.
- `tests/`: Backend API and WebSocket tests.

## Live chat

- `GET /api/rooms/{stream_id}/messages?limit=50` returns recent chat history
  for the host or a viewer of a live stream.
- `WS /ws/streams/{stream_id}` uses the existing session cookie and requires a
  same-origin connection to an active stream.
- Send a JSON event such as
  `{"type":"chat.send","content":"Hello!"}`. The server validates and stores
  the message, then broadcasts a `chat.message` event only to that stream.
- Chat history is stored in the existing SQLite database. Schema initialization
  adds the messages table without replacing existing user or session data.
- Requests are attributed to the authenticated session; client-supplied user
  IDs and usernames are not used. Message length and send rate are limited.
- Logout and stream end close associated WebSocket connections. The in-memory
  connection manager and rate limiter are designed for the current single
  Uvicorn worker.
