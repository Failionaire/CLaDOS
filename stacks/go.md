# Go Stack Reference

## Idiomatic Patterns

### Gin Route Handler
```go
func setupRoutes(r *gin.Engine, db *gorm.DB) {
    api := r.Group("/api/v1")
    {
        api.GET("/items/:id", getItem(db))
        api.POST("/items", createItem(db))
        api.PUT("/items/:id", updateItem(db))
        api.DELETE("/items/:id", deleteItem(db))
    }
}

func getItem(db *gorm.DB) gin.HandlerFunc {
    return func(c *gin.Context) {
        var item Item
        if err := db.First(&item, "id = ?", c.Param("id")).Error; err != nil {
            if errors.Is(err, gorm.ErrRecordNotFound) {
                c.JSON(http.StatusNotFound, gin.H{"error": "Not found"})
                return
            }
            c.JSON(http.StatusInternalServerError, gin.H{"error": "Internal error"})
            return
        }
        c.JSON(http.StatusOK, item)
    }
}
```

### GORM Model
```go
type User struct {
    ID        uuid.UUID      `gorm:"type:uuid;primaryKey;default:gen_random_uuid()" json:"id"`
    Email     string         `gorm:"uniqueIndex;not null" json:"email"`
    Name      string         `gorm:"not null" json:"name"`
    Posts     []Post         `gorm:"foreignKey:AuthorID" json:"posts,omitempty"`
    CreatedAt time.Time      `json:"created_at"`
    UpdatedAt time.Time      `json:"updated_at"`
    DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}
```

### Middleware
```go
func AuthMiddleware(secret string) gin.HandlerFunc {
    return func(c *gin.Context) {
        token := c.GetHeader("Authorization")
        if token == "" {
            c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Missing token"})
            return
        }
        token = strings.TrimPrefix(token, "Bearer ")
        claims, err := validateJWT(token, secret)
        if err != nil {
            c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "Invalid token"})
            return
        }
        c.Set("user", claims)
        c.Next()
    }
}
```

### Error Handling
```go
func errorHandler() gin.HandlerFunc {
    return func(c *gin.Context) {
        c.Next()
        if len(c.Errors) > 0 {
            err := c.Errors.Last()
            log.Printf("request error: %v", err)
            c.JSON(http.StatusInternalServerError, gin.H{"error": "Internal server error"})
        }
    }
}
```

## Dependency Management

```bash
# Initialize module
go mod init github.com/org/project

# Add dependencies
go get github.com/gin-gonic/gin
go get gorm.io/gorm
go get gorm.io/driver/postgres

# Tidy (remove unused, add missing)
go mod tidy

# Vendor dependencies (optional, for reproducible builds)
go mod vendor
```

## Dockerfile Template

```dockerfile
# Build stage
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /server ./cmd/server

# Runtime stage
FROM alpine:3.19
RUN apk --no-cache add ca-certificates
WORKDIR /app
COPY --from=builder /server .
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
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - run: go mod tidy
      - run: go vet ./...
      - run: go test -v -race -count=1 ./...
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/testdb?sslmode=disable
```

## Test Patterns

### Unit Test
```go
func TestGetItem_NotFound(t *testing.T) {
    db := setupTestDB(t)
    router := setupRouter(db)

    w := httptest.NewRecorder()
    req, _ := http.NewRequest("GET", "/api/v1/items/nonexistent", nil)
    router.ServeHTTP(w, req)

    assert.Equal(t, http.StatusNotFound, w.Code)
    var resp map[string]string
    json.Unmarshal(w.Body.Bytes(), &resp)
    assert.Equal(t, "Not found", resp["error"])
}
```

### Integration Test with Database
```go
func TestCreateItem_Integration(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping integration test")
    }
    db := setupTestDB(t)
    router := setupRouter(db)

    body := `{"name": "Test Item", "description": "A test"}`
    w := httptest.NewRecorder()
    req, _ := http.NewRequest("POST", "/api/v1/items", strings.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    router.ServeHTTP(w, req)

    assert.Equal(t, http.StatusCreated, w.Code)

    var item Item
    json.Unmarshal(w.Body.Bytes(), &item)
    assert.NotEmpty(t, item.ID)
    assert.Equal(t, "Test Item", item.Name)
}
```

### Test DB Helper
```go
func setupTestDB(t *testing.T) *gorm.DB {
    t.Helper()
    dsn := os.Getenv("DATABASE_URL")
    if dsn == "" {
        dsn = "postgres://test:test@localhost:5432/testdb?sslmode=disable"
    }
    db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
    require.NoError(t, err)
    db.AutoMigrate(&Item{}, &User{})
    t.Cleanup(func() {
        sqlDB, _ := db.DB()
        sqlDB.Close()
    })
    return db
}
```

## Security Patterns

- **SQL Injection**: Always use GORM's parameterized queries. Never use `db.Raw()` with string concatenation.
- **Input Validation**: Use `binding:"required"` struct tags with Gin's `ShouldBindJSON()`.
- **Rate Limiting**: Use `github.com/ulule/limiter/v3` middleware.
- **CORS**: Configure `github.com/gin-contrib/cors` with explicit allowed origins.
- **Secrets**: Use environment variables via `os.Getenv()`, never hardcode.
- **Error Exposure**: Never return internal error details to clients. Log with `log.Printf`, respond with generic message.
