# Rust Stack Reference

## Idiomatic Patterns

### Axum Route Handler
```rust
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post, put, delete},
    Json, Router,
};

pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/items", get(list_items).post(create_item))
        .route("/api/v1/items/:id", get(get_item).put(update_item).delete(delete_item))
        .with_state(state)
}

async fn get_item(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Item>, AppError> {
    let item = sqlx::query_as!(Item, "SELECT * FROM items WHERE id = $1", id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(item))
}
```

### Diesel Model
```rust
use diesel::prelude::*;
use uuid::Uuid;
use chrono::NaiveDateTime;

#[derive(Queryable, Selectable, Identifiable, Serialize)]
#[diesel(table_name = users)]
pub struct User {
    pub id: Uuid,
    pub email: String,
    pub name: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

#[derive(Insertable, Deserialize)]
#[diesel(table_name = users)]
pub struct NewUser {
    pub email: String,
    pub name: String,
}
```

### SQLx Model (alternative to Diesel)
```rust
#[derive(Debug, sqlx::FromRow, Serialize)]
pub struct Item {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
```

### Middleware (Axum Tower)
```rust
use axum::middleware::{self, Next};
use axum::extract::Request;
use axum::response::Response;

async fn auth_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let token = req.headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)?;

    let claims = validate_jwt(token, &state.jwt_secret)?;
    req.extensions_mut().insert(claims);
    Ok(next.run(req).await)
}
```

### Error Handling
```rust
use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};

pub enum AppError {
    NotFound,
    Unauthorized,
    Internal(anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "Not found"),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "Unauthorized"),
            AppError::Internal(e) => {
                tracing::error!("Internal error: {e:?}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
        };
        (status, Json(serde_json::json!({"error": message}))).into_response()
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(err: E) -> Self {
        AppError::Internal(err.into())
    }
}
```

## Dependency Management

```bash
# Create new project
cargo init --name project-name

# Add dependencies (uses cargo-edit or Cargo.toml directly)
cargo add axum tokio serde serde_json
cargo add sqlx --features runtime-tokio,postgres,uuid,chrono
cargo add tower-http --features cors,trace
cargo add uuid --features v4,serde
cargo add chrono --features serde

# Build
cargo build --release

# Check without building
cargo check

# Format
cargo fmt

# Lint
cargo clippy -- -D warnings
```

## Dockerfile Template

```dockerfile
# Build stage
FROM rust:1.77-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY . .
RUN cargo build --release

# Runtime stage
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/server .
EXPOSE 8080
USER nobody
CMD ["./server"]
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
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: testdb
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt -- --check
      - run: cargo clippy -- -D warnings
      - run: cargo test
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/testdb?sslmode=disable
```

## Test Patterns

### Unit Test
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_get_item_not_found() {
        let app = create_router(test_state().await);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/items/00000000-0000-0000-0000-000000000000")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
```

### Integration Test
```rust
#[tokio::test]
async fn test_create_item_integration() {
    let state = test_state().await;
    let app = create_router(state);

    let body = serde_json::json!({"name": "Test Item", "description": "A test"});
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/items")
                .header("Content-Type", "application/json")
                .body(Body::from(serde_json::to_string(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
}
```

### Test Helper
```rust
async fn test_state() -> AppState {
    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://test:test@localhost:5432/testdb".to_string());
    let pool = sqlx::PgPool::connect(&database_url).await.unwrap();
    sqlx::migrate!().run(&pool).await.unwrap();
    AppState { pool, jwt_secret: "test-secret".to_string() }
}
```

## Security Patterns

- **SQL Injection**: Use SQLx parameterized queries (`$1`, `$2`) or Diesel's type-safe query builder. Never use `format!()` for SQL.
- **Input Validation**: Derive `Deserialize` with `#[serde(deny_unknown_fields)]`. Use validator crate for complex rules.
- **Rate Limiting**: Use `tower_governor` middleware.
- **CORS**: Configure `tower_http::cors::CorsLayer` with explicit allowed origins.
- **Secrets**: Use `std::env::var()`, never hardcode. Consider `dotenvy` for local development.
- **Error Exposure**: Implement `IntoResponse` on error types. Log internal details with `tracing`, return generic messages.
- **Memory Safety**: Rust's ownership system handles most memory issues. Watch for `unsafe` blocks and `.unwrap()` in production code.
