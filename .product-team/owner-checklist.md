# Owner checklist

One-time setup only the owner can do. Agents never see secret values; they reference `secrets.NAME` in
workflows. Tick an item by editing this file in a PR, or comment `/approve` on the linked question issue.

## Аккаунты и облако Cloudflare (только бесплатные тарифы)

Из ADR 0001 → Consequences (`docs/decisions/0001-stack-and-architecture.md`) и грумминга/ревью #7, #21, #25.
Каждый шаг — то, что можешь сделать только ты (аккаунт, токен, секрет, настройка GitHub); агенты этого не
видят и не делают за тебя.

- [x] GitHub-репозиторий `geeera/team-console` (публичный), ветка по умолчанию `dev`; `main`, `stage`, `dev` есть.

### Уже сделано
- [x] Аккаунт Cloudflare, поддомен `workers.dev`, Cloudflare Zero Trust (бесплатная команда).
- [x] API-токен Cloudflare (создан с правами Workers Scripts — Edit, D1 — Edit, Account — Read) — но пока лежит
      как **repository-level** секрет в Settings → Secrets and variables → Actions. Это неправильное место
      (любой workflow на любой ветке его видит); шаг 1 ниже переносит его в окружения и удаляет отсюда.
- [x] GitHub Environments `dev`, `stage`, `production` **уже созданы** (командой, через API, с твоего
      согласия) с branch policy: `dev` → ветка `dev`, `stage` → ветка `stage`, `production` → ветка `main`.
      На `production` включён required reviewer `geeera` (ты); "Prevent self-review" на нём **намеренно
      выключен** — ты единственный ревьюер и часто сам же мержишь релизный PR, включённая опция просто
      заблокировала бы деплой навсегда (боты ревьюерами не являются и подтвердить деплой не могут).

### Дальше — по порядку (D1 и Access нужны ДО первого же деплоя **каждого** окружения, включая dev — не
только stage: `deploy.yml`'s smoke-check нарочно проваливает деплой любого окружения, если `/` отвечает 200
без авторизации, то есть без Access первый dev-деплой в #25 упадёт — это ожидаемо, не регрессия)

1. **Секреты Cloudflare + WEBHOOK_SECRET + VAPID_PRIVATE_KEY — одним скриптом.**
   1. Установи GitHub CLI (`gh`) и выполни `gh auth login`, если ещё не делал.
   2. В терминале, в корне склонированного репозитория, выполни `npx wrangler login` (откроется браузер —
      это привязывает `wrangler` на твоей машине к твоему аккаунту Cloudflare, отдельно от `CLOUDFLARE_API_TOKEN`
      в GitHub, который используют только Actions).
   3. Запусти `bash tools/owner-setup/set-secrets.sh`. Скрипт:
      - попросит один раз вставить Cloudflare API-токен и Account ID (ввод скрыт, никуда не пишется и нигде
        не логируется) и положит их секретами `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` в GitHub-окружения
        `dev`, `stage`, `production` (Environment secrets — именно туда, не в Repository secrets);
      - сам сгенерирует и поставит через `wrangler secret put` свежий `WEBHOOK_SECRET` на Worker `hooks` и
        свежую пару VAPID-ключей (приватный ключ — на `api` и `hooks`) для каждого из трёх окружений —
        отдельные значения на каждое окружение (утечка на dev не должна давать что-то подделать в production);
      - в конце напечатает в терминал (не в файл) три **публичных** VAPID-ключа — они не секретны, но нужны
        дальше, шаг 4.
   4. Скрипт ничего не удаляет и не переносит: он только добавляет. Продолжай следующими шагами.

2. **Удали старые repository-level копии.** Settings → Secrets and variables → Actions → **Repository secrets**
   → удали `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID` оттуда (шаг 1 уже положил их в каждое окружение;
   если их оставить и здесь, любой workflow на любой ветке продолжит их видеть, а не только `deploy.yml` через
   нужное окружение).

3. **Добавь токену право на Storybook.** dashboard.cloudflare.com → My Profile → **API Tokens** → найди
   существующий токен → **Edit** → добавь право **Cloudflare Pages: Edit** (у него сейчас только Workers
   Scripts/D1/Account) → Save. Без этого шаг деплоя Storybook в `deploy.yml` упадёт с ошибкой авторизации,
   как только появится `ui` (#13/#34).

4. **`VAPID_PUBLIC_KEY` — три GitHub-переменные (не секреты).** Для каждого окружения из вывода скрипта
   (шаг 1): Settings → **Environments** → `dev` (затем `stage`, `production`) → **Environment variables** →
   **Add variable** → Name `VAPID_PUBLIC_KEY` → Value — публичный ключ этого окружения из терминала.

5. **Pages-проект для Storybook** (нужен до первого деплоя `dev` — `wrangler pages deploy` в CI не создаёт
   проект сам: без TTY он отказывается и просит запустить `wrangler pages project create` заранее, это
   подтверждено исходником wrangler, а не только опытом):
   dashboard.cloudflare.com → **Workers & Pages** → **Create** → вкладка **Pages** → **Upload assets** (Direct
   Upload) → имя проекта ровно `team-console-storybook` → Production branch `dev` → Create project (первую
   загрузку можно пропустить или оставить пустой — `deploy.yml` перезапишет содержимое).

6. **D1-базы — по одной на окружение.**
   1. dashboard.cloudflare.com → **Workers & Pages** → **D1 SQL Database** → **Create database**.
   2. Имя базы — ровно такое: `team-console-dev`, `team-console-stage`, `team-console-production`. Регион —
      Automatic.
   3. Открой созданную базу → **Settings** → скопируй **Database ID**.
   4. Вставь этот id в оба файла — `apps/api/wrangler.jsonc` и `apps/hooks/wrangler.jsonc` — в блок нужного
      окружения (`env.dev` / `env.stage` / `env.production`), в поле `database_id`, вместо плейсхолдера
      `00000000-…` (один и тот же id в обоих файлах — Worker'ы `api` и `hooks` делят одну базу; `deploy.yml`
      проверяет оба файла и не задеплоит окружение, пока в любом из них остался плейсхолдер). Сохрани через
      Pull Request — это задача #25.

7. **Access — по одному приложению на каждый app-Worker** (`team-console-dev`, `team-console-stage`,
   `team-console-production`; **не** на `hooks`-Worker'ы — они обязаны остаться публичными для GitHub-вебхуков,
   ADR 0001 решение 4). Cloudflare-приложение Access создаётся из самого Worker'а, а не отдельно в Zero Trust
   (источник: developers.cloudflare.com/workers/configuration/cloudflare-access/ — раздел "Protect a Worker
   with Cloudflare Access"). Для этого Worker должен уже существовать (хотя бы пустым), поэтому порядок такой:
   1. Если ты ещё ни разу не запускал `deploy.yml` для этого окружения: dashboard.cloudflare.com → **Workers &
      Pages** → **Create** → вкладка **Workers** → шаблон "Hello World" → имя ровно `team-console-<env>` →
      Deploy. (Первый же настоящий деплой из `deploy.yml`, задача #25, перезапишет код этого Worker'а тем же
      именем — Access, привязанный к имени, останется.)
   2. Открой этот Worker → вкладка **Access** → **Protect this Worker behind Access**.
   3. Выбери **All traffic** (не "Previews only" — превью и так выключены в конфиге, `preview_urls: false`,
      но нужен весь трафик на `workers.dev`, ADR 0001 решение 7).
   4. Identity providers: One-time PIN (email) обязательно; GitHub — по желанию.
   5. Policy: Action **Allow** → Include **Emails** → твой email (тот же, что пойдёт в `OWNER_EMAIL`, шаг 9).
   6. **Apply Access** — Cloudflare сама создаёт Access-приложение на все хостнеймы этого Worker'а.
   7. Открой созданное приложение: Zero Trust → **Access** → **Applications** → `team-console-<env>` →
      настрой:
      - **Session Duration**: 24 hours (по умолчанию, ADR 0001 решение 7);
      - **Cookie settings**: включи `HTTP Only`; `SameSite` — `Lax` (или `Strict`); включи `Enable Binding
        Cookie`, если предложен;
      - только для `dev` и `stage` (не для `production`): **Add a policy** → Action **Service Auth** (не
        Allow — иначе Playwright увидит страницу логина, источник:
        developers.cloudflare.com/cloudflare-one/identity/service-tokens/, "Make sure to set the policy action
        to Service Auth") → Include **Service Token** → выбери `team-console-e2e` (создашь в шаге 8; если
        шаг 8 ещё не сделан, вернись сюда после него).
   8. На вкладке **Overview** этого приложения скопируй **Application Audience (AUD) Tag**.
   9. Team domain — тот, что выбирал при создании команды Zero Trust: `<твоя-команда>.cloudflareaccess.com`
      (один и тот же для всех приложений одной команды; Zero Trust → Settings → General).
   10. `ACCESS_AUD` и team domain — это не секреты (публичные идентификаторы, сами по себе доступа не дают),
       поэтому просто напиши их комментарием на задаче #25, по одному на окружение (`team_domain`, `aud` для
       `dev`, `stage`, `production`) — команда впишет их в `apps/api/wrangler.jsonc` (`vars.ACCESS_TEAM_DOMAIN`,
       `vars.ACCESS_AUD`) отдельным Pull Request. Пока они пустые, Worker всё равно отвечает 401 всем — это
       безопасно, просто без них Worker ещё не может сверить `aud`/issuer сам (ADR 0001 решение 7).
   11. Повтори шаги 1–10 для всех трёх окружений.

8. **Service token для e2e** (только `dev` и `stage`, не для `production`):
   1. Zero Trust → **Access controls** → **Service credentials** → **Service Tokens** → **Create Service
      Token**, имя `team-console-e2e`.
   2. Cloudflare покажет **Client ID** и **Client Secret** один раз. **Не вставляй их никуда в этот
      репозиторий** (ни в этот файл, ни в код, ни в комментарий к задаче). Сразу положи их секретами
      GitHub-окружений: Settings → **Environments** → `dev` → **Environment secrets** → **Add secret** → имя
      `ACCESS_SERVICE_TOKEN_ID`, значение — Client ID; вторым секретом `ACCESS_SERVICE_TOKEN_SECRET` —
      Client Secret. Повтори то же для окружения `stage`. Не добавляй ни в `production`.
   3. Вернись к шагу 7.7 и привяжи этот токен к Service Auth политике на `dev`- и `stage`-приложениях.

9. **`OWNER_EMAIL`** — секрет самого Worker'а `api` (не GitHub!): по нему Worker проверяет, что JWT от Access
   выдан именно тебе (ADR 0001 решение 7). Для каждого окружения:
   - через CLI (тот же терминал, где уже сделан `npx wrangler login` для шага 1): `npx wrangler secret put
     OWNER_EMAIL --env dev --config apps/api/wrangler.jsonc`, впиши email, когда попросит (и так же для
     `stage`, `production`);
   - или через dashboard: **Workers & Pages** → Worker `team-console-<env>` → **Settings** → **Variables and
     Secrets** → **Add** → Type **Secret** → Name `OWNER_EMAIL` → Value — твой email (тот же, что в Access) →
     **Deploy**. Только на `api`, не на `hooks`.

10. **Fine-grained GitHub-токен для Worker'а `api` — заменяется GitHub App'ом.** ADR 0001 решение 6 предполагало
    два fine-grained PAT (dev/stage на этот репозиторий, production на все продуктовые репозитории). Это
    заменяется отдельным GitHub App для консоли — архитектор сейчас пишет ADR 0003 и добавит точные шаги
    создания приложения комментарием на #7 и на этот PR. **Пока ADR 0003 не готов: секрет `GITHUB_TOKEN`
    Worker'а `api` не заводи** — этот пункт остаётся открытым, чек-лист обновится, как только шаги появятся.

11. **`ROUTINE_TOKEN_<SLUG>`** — токен PM-чата на продукт (ADR 0001 решение 11); делать не раньше, чем появится
    задача, реализующая решения 11/20 — здесь только чтобы имя секрета сразу было верным:
    1. claude.ai/code → создай Claude Code routine для продукта с API-триггером, скопируй её bearer-токен.
    2. Добавь секретом Worker'а `api` с именем `ROUTINE_TOKEN_<SLUG>`, где `<SLUG>` — `slug` продукта из
       таблицы `projects` (например `ROUTINE_TOKEN_TEAM_CONSOLE`).

- [ ] Хостинг: не требуется отдельно — это Cloudflare Workers (см. выше).
- [ ] Аккаунт базы данных: не требуется отдельно — это Cloudflare D1 (см. шаг 6 выше).

## Секреты GitHub Actions (Settings → Environments → `dev` / `stage` / `production` → Environment secrets,
если не сказано иное)
| Секрет | Для чего (какой workflow) | Как завести | Окружения | Готово |
| ------ | -------------------------- | ------------ | --------- | ------ |
| `CLOUDFLARE_API_TOKEN` | `deploy.yml`: миграции D1, деплой обоих Worker'ов и Storybook | `tools/owner-setup/set-secrets.sh` (шаг 1) | dev, stage, production | [ ] (сейчас repository-level — шаги 1–2 переносят) |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.yml` | `tools/owner-setup/set-secrets.sh` (шаг 1) | dev, stage, production | [ ] (сейчас repository-level — шаги 1–2 переносят) |
| `ACCESS_SERVICE_TOKEN_ID` | пока ни одним workflow не используется — появится в #14 (Playwright e2e на stage); имя закреплено сейчас, чтобы не переименовывать позже | шаг 8 выше | dev, stage (не production) | [ ] |
| `ACCESS_SERVICE_TOKEN_SECRET` | пара к `ACCESS_SERVICE_TOKEN_ID`, появится в #14 | шаг 8 выше | dev, stage | [ ] |
| `PT_TELEGRAM_TOKEN` | `owner-digest.yml` | см. «Ежедневная сводка на телефон» ниже | repository-level (свой канал, общий для всех окружений) | [ ] |
| `PT_TELEGRAM_CHAT` | `owner-digest.yml` | см. «Ежедневная сводка на телефон» ниже | repository-level | [ ] |
| `PT_NTFY_TOPIC` | `owner-digest.yml` (альтернатива Telegram) | см. «Ежедневная сводка на телефон» ниже | repository-level | [ ] |

`secrets.GITHUB_TOKEN`, который используют `owner-digest.yml` и `branch-guard.yml`, — встроенный токен
Actions; заводить его не нужно (`deploy.yml` его не использует).

## Переменные GitHub Actions (Settings → Environments → окружение → Environment variables — это НЕ секреты,
значения видны в логах и любому, кто может читать настройки репозитория)
| Переменная | Для чего | Как завести | Окружения | Готово |
| ---------- | -------- | ------------ | --------- | ------ |
| `VAPID_PUBLIC_KEY` | публичный VAPID-ключ, читает клиентский код (появится с #11) | шаг 4 выше, значение из вывода скрипта (шаг 1) | dev, stage, production — своё значение в каждом | [ ] |
| `ACCESS_TEAM_DOMAIN` | JWT-проверка Access в Worker'е `api` (ADR 0001 решение 7); попадает в `apps/api/wrangler.jsonc` через `deploy.yml`'s `--var` | шаг 7.9–7.10 выше — сообщи значение на #25, команда впишет в код | dev, stage, production | [ ] |
| `ACCESS_AUD` | то же самое | шаг 7.8, 7.10 выше | dev, stage, production | [ ] |

## Секреты самих Worker'ов (Cloudflare, не GitHub — либо `tools/owner-setup/set-secrets.sh`, либо `wrangler
secret put` / dashboard → Workers & Pages → Worker → Settings → Variables and Secrets)
| Секрет | Worker | Для чего | Как завести | Окружения | Готово |
| ------ | ------ | -------- | ------------ | --------- | ------ |
| `OWNER_EMAIL` | `api` | проверка JWT от Access (ADR 0001 решение 7) | шаг 9 выше (вручную) | dev, stage, production | [ ] |
| `VAPID_PRIVATE_KEY` | `api`, `hooks` | веб-пуш (ADR 0001 решение 11) | `tools/owner-setup/set-secrets.sh` (шаг 1) — своя пара на каждое окружение | dev, stage, production | [ ] |
| `WEBHOOK_SECRET` | `hooks` | подпись `X-Hub-Signature-256` входящих вебхуков (ADR 0001 решение 20) | `tools/owner-setup/set-secrets.sh` (шаг 1) — своё значение на каждое окружение | dev, stage, production | [ ] |
| `GITHUB_TOKEN` | `api` | fine-grained PAT (ADR 0001 решение 6) | **заменяется GitHub App — см. шаг 10, ждём ADR 0003** | — | отложено |
| `ROUTINE_TOKEN_<SLUG>` | `api` | будит routine PM-чата продукта `<slug>` (ADR 0001 решение 11) | шаг 11 выше | по одному на продукт, когда появится соответствующая задача | [ ] |

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

## Ежедневная сводка на телефон (5 минут)

Агенты пишут в GitHub от твоего имени, а GitHub не присылает уведомлений о твоих же комментариях — поэтому их
вопросы не долетят до телефона сами. `owner-digest.yml` раз в день присылает список «нужен ты» вместо этого.
Выбери один канал и впиши его значения в Settings → Secrets and variables → Actions:

- **Telegram** (рекомендуется): напиши боту @BotFather → `/newbot` → скопируй токен в `PT_TELEGRAM_TOKEN`.
  Напиши что-нибудь своему новому боту, открой в браузере `https://api.telegram.org/bot<токен>/getUpdates` и
  скопируй `chat.id` в `PT_TELEGRAM_CHAT`.
- **ntfy** (без аккаунта): поставь приложение ntfy, подпишись на длинное случайное имя топика, впиши это имя в
  `PT_NTFY_TOPIC`. Топик может прочитать любой, кто его угадает, — делай длинным и случайным.

`owner.language: ru` в `.product-team/project.yml` уже включает сводку и вопросы на русском.

## Claude
- [ ] Scheduled routines created for `slot-pm`, `slot-dev`, `slot-qa` (see the plugin README)
- [ ] Project chat created for owner ↔ team conversation
- [ ] One digest channel set up (see "Ежедневная сводка на телефон" above) — GitHub notifications do not show
      the agents' questions while they write as your account

## Budget
Budget is **$0**. Any paid plan, upgrade or domain arrives as a `kind:question` issue; nothing is bought without
your `/approve` there.
