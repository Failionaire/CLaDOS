# Python Stack Reference

## Idiomatic Patterns

### FastAPI Route Handler
```python
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.orm import Session
from .database import get_db
from .models import Item
from .schemas import ItemCreate, ItemResponse

router = APIRouter(prefix="/api/items", tags=["items"])

@router.get("/{item_id}", response_model=ItemResponse)
async def get_item(item_id: str, db: Session = Depends(get_db)):
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    return item

@router.post("/", response_model=ItemResponse, status_code=201)
async def create_item(data: ItemCreate, db: Session = Depends(get_db)):
    item = Item(**data.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item
```

### SQLAlchemy Model
```python
from sqlalchemy import Column, String, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid
from .database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    posts = relationship("Post", back_populates="author")
```

### Pydantic Schema
```python
from pydantic import BaseModel, EmailStr
from datetime import datetime
from uuid import UUID

class UserCreate(BaseModel):
    email: EmailStr
    name: str

class UserResponse(BaseModel):
    id: UUID
    email: str
    name: str
    created_at: datetime

    class Config:
        from_attributes = True
```

### Dependency Injection (Auth)
```python
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import jwt

security = HTTPBearer()

async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
):
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=["HS256"])
        user = db.query(User).filter(User.id == payload["sub"]).first()
        if not user:
            raise HTTPException(status_code=401, detail="Invalid token")
        return user
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
```

### Error Handling
```python
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"error": "Internal server error"})
```

## Dependency Management
- Install: `pip install -r requirements.txt`
- Add dependency: Add to `requirements.txt` then `pip install -r requirements.txt`
- Virtual environment: `python -m venv .venv && source .venv/bin/activate`
- Lock file: `pip freeze > requirements.txt` (or use `pip-tools` for split files)

## Dockerfile Template
```dockerfile
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY . .
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

## CI Template (GitHub Actions)
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports: ['5432:5432']
        options: --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install -r requirements.txt
      - run: alembic upgrade head
        env: { DATABASE_URL: 'postgresql://test:test@localhost:5432/test' }
      - run: pytest --tb=short -q
        env: { DATABASE_URL: 'postgresql://test:test@localhost:5432/test' }
```

## Test Patterns

### pytest + httpx Integration
```python
import pytest
from httpx import AsyncClient, ASGITransport
from app.main import app

@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

@pytest.mark.asyncio
async def test_get_users(client):
    response = await client.get("/api/users")
    assert response.status_code == 200
    assert isinstance(response.json(), list)

@pytest.mark.asyncio
async def test_create_user(client):
    response = await client.post("/api/users", json={"email": "test@example.com", "name": "Test"})
    assert response.status_code == 201
    assert response.json()["email"] == "test@example.com"
```

### Unit Test
```python
from app.utils import validate_email

def test_valid_email():
    assert validate_email("user@example.com") is True

def test_invalid_email():
    assert validate_email("not-an-email") is False
```

## Security Patterns
- Use `passlib[bcrypt]` for password hashing
- Use `python-jose[cryptography]` or `PyJWT` for JWT
- Use `python-multipart` for form data parsing
- Use CORS middleware with explicit allowed origins
- Use Alembic for database migrations (never raw CREATE TABLE)
- Use parameterized queries (SQLAlchemy handles this automatically)
- Never use `eval()`, `exec()`, or string-formatted SQL
- Validate request bodies with Pydantic models (automatic in FastAPI)
- Store secrets in environment variables, use `python-dotenv` for local dev
