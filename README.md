# TradeLens

ACL Smart Solutions Ltd product research and approval workspace.

## Run in Codespaces

Use Node.js 24 and run `node server.mjs`. Open forwarded port 3000 and keep it private. No dependencies or provider keys are needed for manual research. The app stores records in `tradelens.sqlite`. Set `TRADELENS_DB` to override the path.

For a remote deployment set `HOST=0.0.0.0`, `TRADELENS_PASSWORD` (at least 20 characters), `TRADELENS_ORIGIN` (the exact public HTTPS origin), and a durable `TRADELENS_DB` path. Use HTTPS and sign in as `admin`. Use one application instance with a persistent disk for this SQLite build.

## Current scope

Manually capture US and UK product variants, source links and per-order estimates. The dashboard calculates contribution, margin and break-even acquisition cost. Approvals are recorded locally for handoff. Provider cards identify planned workflows. Live connectors, Shopify draft writes, scoring, validation badges and scheduled jobs are future work.
