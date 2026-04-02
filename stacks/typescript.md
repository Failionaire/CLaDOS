# TypeScript Stack Reference

## Idiomatic Patterns

### Express Route Handler
```typescript
import { Router, Request, Response, NextFunction } from 'express';
const router = Router();

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const item = await prisma.item.findUnique({ where: { id: req.params.id } });
    if (!item) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(item);
  } catch (err) { next(err); }
});
```

### Prisma Model
```prisma
model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String
  posts     Post[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

### Middleware
```typescript
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: 'Missing token' }); return; }
  try {
    req.user = verifyToken(token);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}
```

### Error Handling
```typescript
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});
```

## Dependency Management
- Install: `npm ci` (lockfile-based, CI-safe)
- Add dependency: `npm install <package>`
- Add dev dependency: `npm install -D <package>`
- Lock file: `package-lock.json`

## Dockerfile Template
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
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
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx prisma migrate deploy
        env: { DATABASE_URL: 'postgresql://test:test@localhost:5432/test' }
      - run: npm test
        env: { DATABASE_URL: 'postgresql://test:test@localhost:5432/test' }
```

## Test Patterns

### Jest + Supertest Integration
```typescript
import request from 'supertest';
import { app } from '../src/app';

describe('GET /api/users', () => {
  it('returns 200 with array', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/users/profile');
    expect(res.status).toBe(401);
  });
});
```

### Unit Test
```typescript
import { validateEmail } from '../src/utils';

describe('validateEmail', () => {
  it('accepts valid emails', () => {
    expect(validateEmail('user@example.com')).toBe(true);
  });
  it('rejects invalid emails', () => {
    expect(validateEmail('not-an-email')).toBe(false);
  });
});
```

## Security Patterns
- Use `bcrypt` or `argon2` for password hashing (never store plaintext)
- Use `jsonwebtoken` for JWT with `RS256` or `HS256`
- Use `helmet` middleware for HTTP security headers
- Use `express-rate-limit` for rate limiting
- Use parameterized queries (Prisma handles this automatically)
- Never interpolate user input into SQL strings
- Validate request bodies with `express-openapi-validator` or `zod`
- Store secrets in environment variables, never in code
