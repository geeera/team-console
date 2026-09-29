# team-console
Control panel for the product team: questions, PM chat, sprint board, designs — on iPhone and Mac

## Develop

Node 22 (`.nvmrc`) and npm.

```
npm ci
npx nx serve console          # http://localhost:4200 (Angular dev server)
npx nx serve api              # http://localhost:8787 (app shell + /api/v1/* on a local D1, wrangler dev)
npx nx run-many -t lint test build
```

Or the container, which is also the e2e target:

```
docker build -t team-console . && docker run --rm -p 127.0.0.1:8787:8787 team-console
```

The workspace layout, tags and aliases are described in `CLAUDE.md`; the stack in `docs/decisions/`.
