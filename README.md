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

- `backend/main.py`: FastAPI application and health endpoint.
- `frontend/`: Static HTML, CSS, and JavaScript served by the backend.
- `requirements.md`: Project dependency and setup notes.
