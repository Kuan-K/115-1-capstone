from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Project paths
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

# Create FastAPI application
app = FastAPI(title="Capstone Live Streaming Platform")

# Serve CSS and JavaScript
app.mount(
    "/static",
    StaticFiles(directory=FRONTEND_DIR),
    name="static"
)

# Website homepage
@app.get("/")
async def home():
    return FileResponse(FRONTEND_DIR / "index.html")

# Backend status API
@app.get("/api/status")
async def status():
    return {
        "status": "running",
        "message": "FastAPI backend is working",
        "project": "Interactive Live Streaming Platform"
    }
