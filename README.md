# Over18 — AI Companion (PoC)

Monorepo for the Over18 AI companion proof of concept.

## Architecture

```
React Web (apps/web)  ──HTTP──▶  REST API (apps/api)  ──▶  Backend services  ──▶  PostgreSQL (Railway)
```

Core principle: **the frontend never talks to PostgreSQL directly.** All data access goes through the REST API. Later stories will add an AI Orchestrator between the backend and the LLM, plus Drizzle ORM for the database layer.

## Project structure

```
over18/
├── apps/
│   ├── web/          # React + TypeScript + Vite frontend (Tailwind CSS, React Router)
│   │   └── src/
│   │       ├── components/   # AppLayout (mobile-first shell), shared UI
│   │       ├── pages/        # One component per route
│   │       └── lib/api.ts    # The only place the frontend talks to the API
│   └── api/          # Fastify + TypeScript REST API
│       └── src/
│           ├── app.ts        # Fastify instance + routes (GET /health)
│           └── server.ts     # Entry point
├── packages/
│   └── shared/       # @over18/shared — TypeScript types shared by web and api
└── package.json      # npm workspaces root
```

## Current routes (application shell, US-01)

| Route | Purpose |
| --- | --- |
| `/` | Home (shows live API health status) |
| `/login` | Login placeholder |
| `/register` | Registration placeholder |
| `/characters` | Character list placeholder |
| `/characters/:characterId` | Character detail placeholder |
| `/chat/:conversationId` | Chat placeholder |

API: `GET /health` → `{ "status": "ok", "service": "over18-api", "timestamp": "…" }`

## Authentication (US-02)

Server-managed sessions with HttpOnly cookies:

- `POST /api/auth/register` — `{ email, password }` → creates user + session, sets cookie, returns `{ id, email }`
- `POST /api/auth/login` — `{ email, password }` → verifies, sets cookie, returns `{ id, email }`
- `POST /api/auth/logout` — deletes the session, clears the cookie
- `GET /api/auth/me` — returns `{ id, email }` for the current session, else 401
- `GET /api/chat/:conversationId` — protected placeholder (requires authentication)

## Characters (US-03)

- `GET /api/characters` — public; returns active characters ordered by display name. Internal fields (`system_prompt`, `status`) are never exposed; the wire shape is `PublicCharacter` in `@over18/shared`.
- Schema: `characters` table (uuid id, unique `name` slug, `display_name`, nullable `profile_image`, `short_bio`, `personality`, `interests` text[], `conversation_style`, `system_prompt`, `status` enum active|inactive, timestamps) — migration `0001`.
- Seeding: `npm run db:seed -w apps/api` upserts 3 deterministic characters (Luna, Ember, Sage) by fixed UUIDs — idempotent, safe to re-run anywhere `DATABASE_URL` points (run it once on Railway after migrating).

Design notes: passwords are bcrypt-hashed (cost 12) and never returned by the API; session tokens are 32 random bytes, stored only as SHA-256 hashes (`sessions.token_hash`); the raw token lives exclusively in the `over18_session` HttpOnly cookie (SameSite=Lax by default, Secure in production, Path=/, explicit Max-Age). Nothing auth-related is stored in localStorage. Login failures return a generic message that does not reveal whether an email exists. The service layer (`apps/api/src/services/auth-service.ts`) is transport-agnostic so a React Native client can reuse it with bearer tokens later.

## Database

Drizzle ORM + migrations live in `apps/api`:

```bash
# Generate a migration after editing src/db/schema.ts
npm run db:generate -w apps/api

# Apply migrations to the database in DATABASE_URL
npm run db:migrate -w apps/api

# Upsert the deterministic seed characters (idempotent)
npm run db:seed -w apps/api
```

Tables are only created via migrations (`apps/api/drizzle/`) — never by hand. On Railway, run migrations with the injected `DATABASE_URL`.

## Requirements

- Node.js ≥ 20
- npm ≥ 10 (workspaces)

## Local development

```bash
# 1. Install all workspace dependencies (run at the repo root)
npm install

# 2. Build the shared types package once (also run automatically by npm run build)
npm run build -w packages/shared

# 3. Set up environment files
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# 4. Start web + api together
npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:3001 (health check: http://localhost:3001/health)

Individual apps:

```bash
npm run dev:web   # frontend only
npm run dev:api   # backend only
```

Note: Vite loads `apps/web/.env` automatically. The API reads plain `process.env` and has sensible defaults (port 3001, CORS for localhost:5173), so it runs with no `.env` at all; env loading via dotenv will be added when `DATABASE_URL` is actually needed.

## Build & checks

```bash
npm run build       # builds shared → web → api
npm run typecheck   # strict TypeScript checks for web and api
npm run test -w apps/api   # auth integration tests (needs a local *_test database)
```

Tests refuse to run unless the database name ends in `_test`, so they can never touch the Railway production database. Default: `postgresql://over18:over18_local_dev@127.0.0.1:5432/over18_test` (override with `TEST_DATABASE_URL`).

## Environment variables

### apps/api (`apps/api/.env.example`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — (**required**, API exits if missing) | PostgreSQL connection string (injected by Railway in production) |
| `PORT` | `3001` | API listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed web origin (never `*` — credentials are enabled) |
| `COOKIE_SECURE` | `true` in production, else `false` | `Secure` flag on the session cookie |
| `COOKIE_SAMESITE` | `lax` | SameSite for the session cookie (`none` requires `COOKIE_SECURE=true`) |
| `SESSION_TTL_DAYS` | `30` | Session lifetime |

### apps/web (`apps/web/.env.example`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | `http://localhost:3001` | Base URL of the REST API |

## Out of scope so far

LLM integration, AI orchestration/memory, characters and conversations/messages, payments/credits/subscriptions, image/voice/video generation, swipe algorithm, recommendations, and admin tooling are intentionally **not** implemented yet. Within auth, US-02 deliberately excludes social login, email verification, password reset, MFA, OAuth, account deletion, and role systems.
