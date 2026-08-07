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
```

## Environment variables

### apps/api (`apps/api/.env.example`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | API listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed web origin |
| `DATABASE_URL` | — | Railway PostgreSQL connection string (used from a later story) |

### apps/web (`apps/web/.env.example`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | `http://localhost:3001` | Base URL of the REST API |

## Out of scope for this checkpoint

LLM integration, authentication, database schema/Drizzle setup, AI memory, payments, image/voice/video generation, swipe algorithm, and recommendations are intentionally **not** implemented yet.
