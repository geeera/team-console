# Owner checklist

One-time setup only the owner can do. Agents never see secret values; they reference `secrets.NAME` in
workflows. Tick an item by editing this file in a PR, or comment `/approve` on the linked question issue.

## Аккаунты и облако Cloudflare (только бесплатные тарифы)

Из ADR 0001 → Consequences (`docs/decisions/0001-stack-and-architecture.md`) и грумминга #7/#21. Каждый шаг —
что-то, что можешь сделать только ты (аккаунт, токен, секрет); агенты этого не видят и не делают за тебя.

- [x] GitHub-репозиторий `geeera/team-console` (публичный), ветка по умолчанию `dev`; `main`, `stage`, `dev` есть.

### Этап 1 — уже сделано (29.09, см. #21)
- [x] Аккаунт Cloudflare, поддомен `workers.dev`
- [x] Cloudflare Zero Trust, бесплатная команда
- [x] API-токен Cloudflare для GitHub Actions (права: Workers Scripts — Edit, D1 — Edit, Account — Read) →
      секреты `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID` уже лежат в Settings → Secrets and variables →
      Actions этого репозитория

### Этап 2 — сделать по этому чек-листу
Порядок важен: сначала D1-базы (нужны для первого деплоя, #25), потом Access и остальные секреты (нужны до
деплоя `stage`, т.к. критерий «stage за Access» иначе не выполнить).

1. **D1-базы — по одной на окружение.**
   1. dashboard.cloudflare.com → **Workers & Pages** → **D1 SQL Database** → **Create database**.
   2. Имя базы — ровно такое: `team-console-dev`, `team-console-stage`, `team-console-production`. Регион —
      Automatic.
   3. Открой созданную базу → **Settings** → скопируй **Database ID**.
   4. Вставь этот id в оба файла — `apps/api/wrangler.jsonc` и `apps/hooks/wrangler.jsonc` — в блок нужного
      окружения (`env.dev` / `env.stage` / `env.production`), в поле `database_id`, вместо плейсхолдера
      `00000000-…` (один и тот же id в обоих файлах — Worker'ы `api` и `hooks` делят одну базу). Сохрани через
      Pull Request — это задача #25; пока плейсхолдер на месте, `deploy.yml` сам откажется деплоить это
      окружение на шаге «Guard against placeholder D1 database ids» и не тронет Cloudflare.

2. **Access-приложение на каждый app-Worker** (`team-console-dev`, `team-console-stage`,
   `team-console-production` — три хостнейма `<name>.<account>.workers.dev`; **не** на `hooks`-Worker'ы, они
   обязаны остаться публичными для GitHub-вебхуков, ADR 0001 решение 4). Повтори для всех трёх:
   1. Zero Trust → **Access** → **Applications** → **Add an application** → **Self-hosted**.
   2. Application name: `team-console-<env>`. Application domain: точный хостнейм этого Worker'а
      (`team-console-<env>.<твой-account>.workers.dev` — посмотреть его можно в Workers & Pages → сам Worker →
      **Settings** → **Domains & Routes** после первого деплоя).
   3. **Session Duration**: 24 hours (по умолчанию, ADR 0001 решение 7).
   4. **Cookie settings**: включи `HTTP Only`; `SameSite` — `Lax` (или `Strict`); если Cloudflare предлагает
      `Enable Binding Cookie` — включи и его.
   5. **Identity providers**: One-time PIN (email) обязательно; GitHub — по желанию.
   6. **Policies** → **Add a policy** → Action **Allow** → Include **Emails** → впиши свой email (тот же, что
      пойдёт в секрет `OWNER_EMAIL`, шаг 4).
   7. Только для `dev` и `stage` (не для `production`): добавь вторую строку Include → **Service Token** и
      выбери токен, созданный в шаге 3, — так Playwright e2e проходит Access без PIN.
   8. **Save**.

3. **Service token для e2e** (только `dev` и `stage`, не для `production`):
   1. Zero Trust → **Access** → **Service Auth** → **Service Tokens** → **Create Service Token**, имя
      `team-console-e2e`.
   2. Cloudflare покажет **Client ID** и **Client Secret** один раз — сразу скопируй оба в таблицу секретов
      ниже (`ACCESS_SERVICE_TOKEN_ID`, `ACCESS_SERVICE_TOKEN_SECRET`).
   3. Вернись в шаг 2.7 и добавь этот токен в Access-приложения `dev` и `stage`.

4. **`OWNER_EMAIL`** — секрет самого Worker'а `api` (не GitHub!): по нему Worker проверяет, что JWT от Access
   выдан именно тебе (ADR 0001 решение 7). Для каждого окружения:
   1. dashboard.cloudflare.com → **Workers & Pages** → выбери Worker `team-console-<env>` → **Settings** →
      **Variables and Secrets** → **Add** → Type **Secret** → Name `OWNER_EMAIL` → Value — твой email (тот же,
      что в Access) → **Deploy**.
   2. Повтори для `dev`, `stage`, `production` (только Worker `api`, не `hooks`).
   Через CLI вместо dashboard, если у тебя установлен Node: `npx wrangler secret put OWNER_EMAIL --env dev
   --config apps/api/wrangler.jsonc` (и так же для `stage`, `production`).

5. **`VAPID_PRIVATE_KEY`** — веб-пуш (ADR 0001 решение 11), нужен на **обоих** Worker'ах каждого окружения:
   1. Сгенерируй пару ключей один раз, например `npx web-push generate-vapid-keys` на своём компьютере.
   2. Тем же способом, что в шаге 4, добавь секрет `VAPID_PRIVATE_KEY` на Worker `api` И на Worker `hooks` для
      `dev`, `stage`, `production` (итого 6 мест). Публичный ключ секретом не является, впишется в код позже.

6. **Fine-grained GitHub-токен** для Worker'а `api` (секрет `GITHUB_TOKEN`, ADR 0001 решение 6). Нужны **два**
   токена — отдельно для dev/stage и отдельно для production (из грумминга #7: утечка со стейджа не должна
   давать доступ к чужим продуктовым репозиториям):
   1. github.com → аватар → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained
      tokens** → **Generate new token**.
   2. Токен №1 (dev+stage): **Repository access** → Only select repositories → `geeera/team-console` только.
   3. Токен №2 (production): **Repository access** → перечисли все репозитории продуктов, которыми управляет
      консоль (сейчас так же только `geeera/team-console`; добавляй остальные по мере регистрации новых
      продуктов, ADR 0001 решение 20).
   4. Для обоих: **Permissions** → Repository permissions → `Metadata: Read-only`, `Issues: Read and write`,
      `Pull requests: Read-only`, `Contents: Read-only`, `Actions: Read-only`. Больше ничего не включай.
      **Expiration**: 1 год — запиши дату истечения в таблицу ниже и продли токен до неё.
   5. Сохрани токен №1 секретом `GITHUB_TOKEN` Worker'а `api` для `dev` и для `stage` (шаг 4 — способ тот же,
      Variables and Secrets); токен №2 — секретом `GITHUB_TOKEN` Worker'а `api` для `production`.

7. **`WEBHOOK_SECRET`** — общий секрет GitHub-вебхуков (ADR 0001 решение 20), нужен только Worker'у `hooks`:
   1. Сгенерируй случайную строку 32+ символов (например `openssl rand -hex 32` в терминале).
   2. Добавь секретом `WEBHOOK_SECRET` на Worker `hooks` для `dev`, `stage`, `production` (способ — как в шаге
      4, но на Worker'е `hooks`). Один и тот же секрет на все окружения и все будущие продукты — payload сам
      называет свой репозиторий.
   3. Когда регистрируешь продуктовый репозиторий (появится с ADR 0001 решением 20): в этом репозитории →
      **Settings** → **Webhooks** → **Add webhook** → Payload URL — адрес Worker'а `hooks` этого окружения
      (`https://team-console-hooks-<env>.<account>.workers.dev/hooks/github`, появится с #12) → Content type
      `application/json` → Secret — та же строка, что в `WEBHOOK_SECRET` → события: `issues`, `issue_comment`,
      `pull_request`, `workflow_run`, `release`, `push`.

8. **`ROUTINE_TOKEN_<SLUG>`** — токен PM-чата на продукт (ADR 0001 решение 11); делать не раньше, чем появится
   задача, реализующая решения 11/20 — здесь только чтобы имя секрета сразу было верным:
   1. claude.ai/code → создай Claude Code routine для продукта с API-триггером, скопируй её bearer-токен.
   2. Добавь секретом Worker'а `api` с именем `ROUTINE_TOKEN_<SLUG>`, где `<SLUG>` — `slug` продукта из таблицы
      `projects` (например `ROUTINE_TOKEN_TEAM_CONSOLE`).

- [ ] Хостинг: не требуется отдельно — это Cloudflare Workers (см. выше).
- [ ] Аккаунт базы данных: не требуется отдельно — это Cloudflare D1 (см. шаг 1 выше).

## Секреты GitHub Actions (Settings → Secrets and variables → Actions → Environments `dev`/`stage`/`production`)
| Секрет | Для чего (какой workflow) | Где завести | Окружения | Готово |
| ------ | -------------------------- | ------------ | --------- | ------ |
| `CLOUDFLARE_API_TOKEN` | `deploy.yml`: миграции D1, деплой обоих Worker'ов и Storybook | dashboard.cloudflare.com → My Profile → API Tokens → Create Token (Workers Scripts: Edit, D1: Edit, Account: Read, Cloudflare Pages: Edit) | dev, stage, production | [x] |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.yml` | dashboard.cloudflare.com → правая панель любой страницы аккаунта | dev, stage, production | [x] |
| `PT_TELEGRAM_TOKEN` | `owner-digest.yml` | см. «Daily digest on your phone» ниже | repository-level | [ ] |
| `PT_TELEGRAM_CHAT` | `owner-digest.yml` | см. «Daily digest on your phone» ниже | repository-level | [ ] |
| `PT_NTFY_TOPIC` | `owner-digest.yml` (альтернатива Telegram) | см. «Daily digest on your phone» ниже | repository-level | [ ] |
| `ACCESS_SERVICE_TOKEN_ID` | пока ни одним workflow не используется — появится в #14 (Playwright e2e на stage); имя закреплено сейчас, чтобы не переименовывать позже | Zero Trust → Access → Service Auth → Service Tokens (шаг 3 выше) | dev, stage (не production) | [ ] |
| `ACCESS_SERVICE_TOKEN_SECRET` | пара к `ACCESS_SERVICE_TOKEN_ID`, появится в #14 | тот же экран, показывается один раз | dev, stage | [ ] |

`secrets.GITHUB_TOKEN`, который использует `deploy.yml`/`branch-guard.yml`, — встроенный токен Actions;
заводить его не нужно.

## Секреты самих Worker'ов (Cloudflare dashboard → Workers & Pages → Worker → Settings → Variables and
Secrets — это **не** секреты GitHub Actions, сюда, в GitHub, они не попадают)
| Секрет | Worker | Для чего | Окружения | Готово |
| ------ | ------ | -------- | --------- | ------ |
| `OWNER_EMAIL` | `api` | проверка JWT от Access (ADR 0001 решение 7) — шаг 4 выше | dev, stage, production | [ ] |
| `VAPID_PRIVATE_KEY` | `api`, `hooks` | веб-пуш (ADR 0001 решение 11) — шаг 5 выше | dev, stage, production | [ ] |
| `GITHUB_TOKEN` | `api` | fine-grained PAT (ADR 0001 решение 6) — шаг 6 выше | dev+stage: токен только на этот репозиторий; production: токен на все продуктовые репозитории | [ ] |
| `WEBHOOK_SECRET` | `hooks` | подпись `X-Hub-Signature-256` входящих вебхуков (ADR 0001 решение 20) — шаг 7 выше | dev, stage, production | [ ] |
| `ROUTINE_TOKEN_<SLUG>` | `api` | будит routine PM-чата продукта `<slug>` (ADR 0001 решение 11) — шаг 8 выше | по одному на продукт, когда появится соответствующая задача | [ ] |

## Защита окружения `production` (сделать до первого релиза, не раньше — иначе некому будет подтверждать)

`deploy.yml` деплоит в `production` по пушу в `main` и вручную (`workflow_dispatch`, тот же путь для отката).
Правило подтверждения — это настройка самого GitHub Environment, её нельзя задать в файле workflow:
1. Settings → **Environments** → **New environment** → имя ровно `production` (если его ещё нет — GitHub
   создаёт его автоматически при первом запуске без всякой защиты, поэтому лучше сделать этот шаг заранее).
2. **Required reviewers** → включи → добавь себя.
3. Теперь каждый деплой в `production` останавливается и ждёт твоего подтверждения (кнопка **Review deployments**
   в запуске Action) — это и есть owner's go на релиз из `reference/workflow.md`, только на уровне GitHub, а не
   только на демо-странице.

## Security hardening (recommended before the first release)

Out of the box every agent acts as your GitHub account: the merge gate and your `/approve`, `/go` comments are
conventions an agent could imitate (the inbox shows a standing "Security setup" item until this is done).

1. **Reviewing account.** Create a GitHub machine account (one free machine account per person is allowed).
   Give it write access to this repository, no admin. Create a fine-grained token for it: this repository only,
   Pull requests read/write, Contents read, Issues read. Put its login in `team.reviewer_logins` in
   `.product-team/project.yml` — from then on only its verdicts count in `scripts/pr gate`.
2. **Separate cloud environment for reviews.** In claude.ai/code create an environment `reviewers` with the
   variable `PT_REVIEW_TOKEN` = that token, and point the `slot-qa` routine at it. Keep `slot-pm` and `slot-dev`
   in the default environment, which has no reviewer token — so a developer agent cannot post a counted verdict.
   (Every role inside one session shares that session's tokens; separation only works between environments.)
3. **Your own commands.** While the agents' GitHub identity is your account, an agent can write a comment that
   looks like yours; the team therefore only takes a release **go** from the demo page or from a comment older
   than the current run. Full separation needs the agents on their own identity as well.
4. **Server-side enforcement (costs money or visibility).** Rulesets that require a review from the reviewing
   account are not available for private repositories on GitHub's free plan. Options: GitHub Pro (paid — needs
   your `/approve` on the budget question) or making the repository public. Until then `branch-guard.yml`
   reports, after the fact, any change that reached `dev`, `stage` or `main` without a merged PR.

## Daily digest on your phone (5 minutes)

The agents write to GitHub as your account, and GitHub never notifies you about your own comments — so their
questions would not reach your phone. `owner-digest.yml` sends the pinned "Needs you" list once a day instead.
Pick one channel and put its values in Settings → Secrets and variables → Actions:

- **Telegram** (recommended): message @BotFather → `/newbot` → copy the token into `PT_TELEGRAM_TOKEN`. Send your new
  bot any message, open `https://api.telegram.org/bot<token>/getUpdates` in a browser and copy `chat.id` into
  `PT_TELEGRAM_CHAT`.
- **ntfy** (no account): install the ntfy app, subscribe to a long random topic name, put that name in
  `PT_NTFY_TOPIC`. Anyone who guesses the topic can read it — keep it long and random.

Set `owner.language` in `.product-team/project.yml` to `ru` for the digest and questions in Russian.

## Claude
- [ ] Scheduled routines created for `slot-pm`, `slot-dev`, `slot-qa` (see the plugin README)
- [ ] Project chat created for owner ↔ team conversation
- [ ] One digest channel set up (see "Daily digest on your phone") — GitHub notifications do not show the agents'
      questions while they write as your account

## Budget
Budget is **$0**. Any paid plan, upgrade or domain arrives as a `kind:question` issue; nothing is bought without
your `/approve` there.
