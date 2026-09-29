# team-console
Control panel for the product team: questions, PM chat, sprint board, designs — on iPhone and Mac

## Develop

Node 22 (`.nvmrc`) and npm.

```
npm ci
npx nx serve console          # http://localhost:4200
npx nx run-many -t lint test build
```

The workspace layout, tags and aliases are described in `CLAUDE.md`; the stack in `docs/decisions/`.
