# User Guide

## quickstart

1. Enter Enviroment
```
.\.venv\Scripts\Activate.ps1
```
*check (.venv) is showing At the head of terminal*

2. open backend
```
python -m uvicorn backend.main:app --reload
```
3. open website
go to google and Open http://127.0.0.1:8000


## develop step

### create virtual Environment
```
python -m venv .venv

.\.venv\Scripts\Activate.ps1 #Enter venv
```

### install fastapi and pwdlib
```
pip install "fastapi[standard]"

pip install "pwdlib[argon2]"
```