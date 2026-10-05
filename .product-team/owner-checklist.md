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
      (любой workflow на любой ветке его видит); шаги 2–3 ниже переносят его в окружения и удаляют отсюда.
- [x] GitHub Environments `dev`, `stage`, `production` **уже созданы** (командой, через API, с твоего
      согласия) с branch policy: `dev` → ветка `dev`, `stage` → ветка `stage`, `production` → ветка `main`.
      На `production` включён required reviewer `geeera` (ты); "Prevent self-review" на нём **намеренно
      выключен** — ты единственный ревьюер и часто сам же мержишь релизный PR, включённая опция просто
      заблокировала бы деплой навсегда (боты ревьюерами не являются и подтвердить деплой не могут).

### Дальше — по порядку (D1 и Access нужны ДО первого же деплоя **каждого** окружения, включая dev — не
только stage: `deploy.yml`'s smoke-check нарочно проваливает деплой любого окружения, если `/` отвечает 200
без авторизации, то есть без Access первый dev-деплой в #25 упадёт — это ожидаемо, не регрессия).
Пока ты не дойдёшь до шага 6 (D1), каждый push в `dev`/`stage`/`main` будет показывать **красный** прогон
`deploy` — это тоже ожидаемо: `guard` нарочно отказывается идти дальше, пока в `wrangler.jsonc` остался
плейсхолдер id базы, и делает это до того, как вообще коснётся Cloudflare (см. `.github/workflows/deploy.yml`).
Не читай эти красные прогоны как регрессию.

0. **Роль/пересоздай Cloudflare API-токен и запиши его права.** У тебя, скорее всего, уже нет значения токена
   из #21 — Cloudflare показывает его только один раз, и GitHub тоже не показывает секрет обратно. Сделай это
   перед шагом 2 (там токен понадобится), и заодно добавь право на Storybook:
   1. dashboard.cloudflare.com → My Profile → **API Tokens** → найди токен из #21 → **Roll** (или, если это
      проще, **Create Token** заново и потом удали старый) — права: **Workers Scripts: Edit**, **D1: Edit**,
      **Account: Read**, **Cloudflare Pages: Edit** (последнее нужно для Storybook — деплой упадёт без него,
      как только появится `ui`, #13/#34).
   2. Скопируй новое значение — оно понадобится один раз, в шаге 2 (`set-secrets.sh` попросит его вставить).
   3. **Account ID** — там же, на dashboard.cloudflare.com, в правой панели любой страницы аккаунта (иногда
      подписано "Account ID" под названием аккаунта).

1. **Склонируй репозиторий и собери зависимости**, если ещё не сделал (нужно, чтобы шаг 2 использовал именно
   pinned `wrangler` 4.124 из `package-lock.json`, а не что попало из `npx`):
   ```
   git clone https://github.com/geeera/team-console && cd team-console && npm ci
   ```
   Затем один раз: `gh auth login` (GitHub CLI) и `npx wrangler login` (откроется браузер — это отдельная
   привязка `wrangler` к твоему аккаунту Cloudflare, не тот же `CLOUDFLARE_API_TOKEN`, что уйдёт в GitHub).

2. **Секреты Cloudflare + VAPID_PRIVATE_KEY — одним скриптом.** Запусти `bash tools/owner-setup/set-secrets.sh`
   (повторный запуск ничего не ломает — уже установленные секреты он пропускает; `--rotate` спросит
   подтверждение на каждый, прежде чем заменить). Скрипт:
   - попросит один раз вставить новый Cloudflare API-токен (из шага 0) и Account ID (ввод скрыт, никуда не
     пишется и нигде не логируется) и положит их секретами `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` в
     GitHub-окружения `dev`, `stage`, `production` (Environment secrets — именно туда, не в Repository
     secrets);
   - сам сгенерирует (через `openssl`, ничего не скачивая) и поставит через `node_modules/.bin/wrangler
     secret put` свежую пару VAPID-ключей (приватный ключ — на `api` и `hooks`) для каждого из трёх
     окружений — отдельные значения на каждое окружение (утечка на dev не должна давать что-то подделать в
     production);
   - в конце напечатает в терминал (не в файл) публичные VAPID-ключи — они не секретны, но нужны дальше, шаг 4;
   - **не** трогает `WEBHOOK_SECRET` — этот секрет должен совпадать с webhook secret'ом консольного GitHub
     App'а и появится вместе с его настройкой (шаг 10 ниже, ADR 0003).
   Побочный эффект, который важен для шага 7: `wrangler secret put` на несуществующий Worker сам создаёт его
   черновиком ("draft"), поэтому после этого шага `team-console-<env>` и `team-console-hooks-<env>` уже
   существуют в dashboard — отдельно их заводить не нужно.

3. **Удали старые repository-level копии — только после того, как шаг 2 отработал успешно.** Settings →
   Secrets and variables → Actions → **Repository secrets** → удали `CLOUDFLARE_API_TOKEN` и
   `CLOUDFLARE_ACCOUNT_ID` оттуда (шаг 2 уже положил их в каждое окружение; если их оставить и здесь, любой
   workflow на любой ветке продолжит их видеть, а не только `deploy.yml` через нужное окружение).

4. **`VAPID_PUBLIC_KEY` — три GitHub-переменные (не секреты).** Для каждого окружения из вывода скрипта
   (шаг 2): Settings → **Environments** → `dev` (затем `stage`, `production`) → **Environment variables** →
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
   ADR 0001 решение 4). Worker'ы уже существуют черновиками после шага 2 — отдельно их создавать не нужно.
   Cloudflare-приложение Access создаётся из самого Worker'а, а не отдельно в Zero Trust (источник:
   developers.cloudflare.com/workers/configuration/cloudflare-access/ — раздел "Protect a Worker with
   Cloudflare Access"). Если вкладки **Access** на черновике ещё нет (не проверено на черновом Worker'е без
   `workers_dev` и без кода — возможно, она появляется только после первого настоящего деплоя): сделай этот
   шаг после первого деплоя `dev` (#25) вместо того, чтобы ждать здесь — тогда smoke-check первого dev-деплоя
   ожидаемо упадёт (root отвечает 200 без авторизации), почини Access и просто перезапусти `deploy.yml`.
   Для каждого из трёх окружений:
   1. dashboard.cloudflare.com → **Workers & Pages** → Worker `team-console-<env>` → вкладка **Access** →
      **Protect this Worker behind Access**.
   2. Выбери **All traffic** (не "Previews only" — превью и так выключены в конфиге, `preview_urls: false`,
      но нужен весь трафик на `workers.dev`, ADR 0001 решение 7).
   3. Identity providers: One-time PIN (email) обязательно; GitHub — по желанию.
   4. Policy: Action **Allow** → Include **Emails** → твой email (тот же, что пойдёт в `OWNER_EMAIL`, шаг 9).
   5. **Apply Access** — Cloudflare сама создаёт Access-приложение на все хостнеймы этого Worker'а.
   6. Открой созданное приложение: Zero Trust → **Access** → **Applications** → `team-console-<env>` →
      настрой:
      - **Session Duration**: 24 hours (по умолчанию, ADR 0001 решение 7);
      - **Cookie settings**: включи `HTTP Only`; `SameSite` — `Lax` (или `Strict`); включи `Enable Binding
        Cookie`, если предложен;
      - только для `dev` и `stage` (не для `production`): **Add a policy** → Action **Service Auth** (не
        Allow — иначе Playwright увидит страницу логина, источник:
        developers.cloudflare.com/cloudflare-one/identity/service-tokens/, "Make sure to set the policy action
        to Service Auth") → Include **Service Token** → выбери `team-console-e2e` (создашь в шаге 8; если
        шаг 8 ещё не сделан, вернись сюда после него).
   7. На вкладке **Overview** этого приложения скопируй **Application Audience (AUD) Tag**.
   8. Team domain — тот, что выбирал при создании команды Zero Trust: `<твоя-команда>.cloudflareaccess.com`
      (один и тот же для всех приложений одной команды; Zero Trust → Settings → General).
   9. **Впиши оба значения СРАЗУ как GitHub Environment variables — это единственное место, где их ждёт
      `deploy.yml`** (никаких PR в `wrangler.jsonc`, никаких комментариев на других задачах — раньше здесь
      было противоречие, теперь только один путь): Settings → **Environments** → `team-console-<env>`'s
      окружение (`dev`/`stage`/`production`) → **Environment variables** → **Add variable** → `ACCESS_TEAM_DOMAIN`
      (значение — team domain без `https://`, просто хост вида `твоя-команда.cloudflareaccess.com`) и
      `ACCESS_AUD` (значение — AUD Tag как есть). Это не секреты (публичные идентификаторы, сами по себе
      доступа не дают), но `deploy.yml` берёт их именно отсюда через `--var`, а `wrangler.jsonc` в коде
      специально оставлен пустым (репозиторий публичный) — значение из переменной всегда побеждает конфиг,
      даже пустое, так что заполнить нужно обе, иначе Worker останется в режиме "не может сверить aud/issuer"
      (безопасно, но бесполезно, ADR 0001 решение 7).
   10. Повтори шаги 1–9 для всех трёх окружений.

8. **Service token для e2e** (только `dev` и `stage`, не для `production`):
   1. Zero Trust → **Access controls** → **Service credentials** → **Service Tokens** → **Create Service
      Token**, имя `team-console-e2e`.
   2. Cloudflare покажет **Client ID** и **Client Secret** один раз. **Не вставляй их никуда в этот
      репозиторий** (ни в этот файл, ни в код, ни в комментарий к задаче). Сразу положи их секретами
      GitHub-окружений: Settings → **Environments** → `dev` → **Environment secrets** → **Add secret** → имя
      `ACCESS_SERVICE_TOKEN_ID`, значение — Client ID; вторым секретом `ACCESS_SERVICE_TOKEN_SECRET` —
      Client Secret. Повтори то же для окружения `stage`. Не добавляй ни в `production`.
   3. Вернись к шагу 7.6 и привяжи этот токен к Service Auth политике на `dev`- и `stage`-приложениях.

9. **`OWNER_EMAIL`** — секрет самого Worker'а `api` (не GitHub!): по нему Worker проверяет, что JWT от Access
   выдан именно тебе (ADR 0001 решение 7). Для каждого окружения:
   - через CLI (тот же терминал, где уже сделан `npx wrangler login` для шага 1): `npx wrangler secret put
     OWNER_EMAIL --env dev --config apps/api/wrangler.jsonc`, впиши email, когда попросит (и так же для
     `stage`, `production`);
   - или через dashboard: **Workers & Pages** → Worker `team-console-<env>` → **Settings** → **Variables and
     Secrets** → **Add** → Type **Secret** → Name `OWNER_EMAIL` → Value — твой email (тот же, что в Access) →
     **Deploy**. Только на `api`, не на `hooks`.

10. **Консольный GitHub App — по одному на окружение, через App Manifest flow** (ADR 0003; заменяет
    fine-grained PAT из ADR 0001 решения 6). Нужны Worker'ы этого окружения уже задеплоенными хотя бы раз
    (их хостнеймы должны существовать — #25), поэтому этот шаг делается **после** первого деплоя окружения, а
    не до него. Для каждого окружения (`dev`, `stage`, `production`) по отдельности:
    0. `gh auth login` должен быть сделан **именно твоим** аккаунтом (владельцем `geeera/team-console`) — скрипт
       сверяет `gh api user` с владельцем репозитория и отказывается продолжать, если они не совпадают (ADR
       0003, решение 2: приложение должно принимать OAuth-обмен только от владельца).
    1. Запусти `bash tools/owner-setup/create-apps.sh --env dev` (потом `--env stage`, потом
       `--env production`; без `--env` скрипт сам пройдёт все три по очереди). Один раз спросит workers.dev
       поддомен твоего аккаунта (dashboard.cloudflare.com → Workers & Pages, вид `<имя>.workers.dev`; это не
       секрет — только строчные латинские буквы, цифры и дефисы, иначе скрипт откажется).
    2. Скрипт поднимет страницу на `127.0.0.1` и попытается открыть её в браузере (если не откроется сама —
       ссылка из терминала). Страница сама отправит форму с прописанными для `team-console-<env>` именем,
       homepage, webhook URL, разрешениями (`metadata: read`, `issues: write`, `pull_requests: read`,
       `contents: read`, `actions: read`) и событиями (`issues`, `issue_comment`, `pull_request`,
       `workflow_run`, `release`, `push`) на github.com/settings/apps/new. **Единственное, что делаешь ты**:
       проверяешь экран подтверждения GitHub и нажимаешь **Create GitHub App** — **не переименовывай** приложение
       на этом экране: скрипт принимает от GitHub только точное совпадение с именем `team-console-<env>`, любое
       другое имя (даже отличающееся на один символ) он расценит как несовпадение и откажется его принять.
    3. GitHub вернёт браузер обратно на `127.0.0.1`; скрипт сам обменяет код, полученный от GitHub, на
       приватный ключ, client secret и webhook secret приложения и **сразу же**, ничего не печатая и никуда не
       сохраняя на диск, положит их: приватный ключ (конвертированный в PKCS#8) и client secret — секретами
       `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_CLIENT_SECRET` Worker'а `api`; webhook secret — секретом
       `WEBHOOK_SECRET` Worker'а `hooks`; свежий `TOKEN_ENCRYPTION_KEY` — секретом `api`; App ID, Client ID и
       твой GitHub-логин — переменными GitHub-окружения `CONSOLE_GITHUB_APP_ID`, `CONSOLE_GITHUB_APP_CLIENT_ID`,
       `OWNER_GITHUB_LOGIN` (не секреты; названы не `GITHUB_APP_ID`/`GITHUB_APP_CLIENT_ID` — GitHub не даёт
       завести переменную окружения с именем, начинающимся на зарезервированный префикс `GITHUB_`; в сам
       Worker `deploy.yml` передаёт их уже под именами `GITHUB_APP_ID`/`GITHUB_APP_CLIENT_ID`, как в ADR 0003).
       В терминале увидишь только имена того, что установлено, ссылку на
       настройки приложения и ссылку на установку — сами значения нигде не печатаются.
    4. Скрипт откроет страницу установки приложения — выбери **Only select repositories**: для `dev` и
       `stage` — только `geeera/team-console`; для `production` — продуктовые репозитории, которыми управляет
       консоль.
    5. **Открой настройки приложения по ссылке из терминала (`https://github.com/settings/apps/<slug>`) и
       проверь вручную**: "Expire user authorization tokens" включён, Device Flow выключен (это значения по
       умолчанию для нового приложения, но скрипт не может их прочитать через Manifest flow — проверь сам).
    6. Повтори шаги 1–5 для оставшихся окружений, затем задеплой каждое окружение заново — новые
       GitHub-переменные окружения доходят до Worker'а только со следующим прогоном `deploy.yml`.
    Повторный запуск `bash tools/owner-setup/create-apps.sh --env <env>` для окружения, где приложение уже
    полностью настроено (обнаруживается по установленному `GITHUB_APP_CLIENT_SECRET`), **ничего не делает** —
    скрипт пропустит его с сообщением "skip"; чтобы всё же создать приложение заново и заменить секреты, добавь
    `--recreate` — скрипт сначала напомнит порядок из ADR 0003 (сначала Disconnect в консоли, потом **удали**
    старое приложение целиком в его настройках на GitHub — Danger Zone → **Delete GitHub App**, отзыва ключа
    недостаточно: имя приложения занято, пока оно существует) и попросит подтвердить, что это сделано.

    **Если запуск оборвался после того, как GitHub уже создал приложение** (ошибка `wrangler`/`openssl`,
    Ctrl-C, таймаут 15 минут после нажатия "Create GitHub App"): скрипт записывает переменную
    `CONSOLE_GITHUB_APP_SLUG` ещё **до** первого обращения к GitHub (не после обмена кода), — при следующем
    запуске он это увидит и покажет ссылку на настройки недосозданного приложения. Проще всего удалить его там (Danger Zone →
    **Delete GitHub App**) и запустить скрипт заново с тем же именем; названия приложений на GitHub глобальные,
    поэтому "создать ещё раз, не удаляя старое" не сработает — GitHub откажет в имени `team-console-<env>` на
    экране подтверждения, и скрипт зависнет в ожидании редиректа, который никогда не придёт (сам оборвётся по
    таймауту через 15 минут, если забыть отменить).

11. **`ROUTINE_TOKEN_<SLUG>`** — токен PM-чата на продукт (ADR 0001 решение 11); делать не раньше, чем появится
    задача, реализующая решения 11/20 — здесь только чтобы имя секрета сразу было верным:
    1. claude.ai/code → создай Claude Code routine для продукта с API-триггером, скопируй её bearer-токен.
    2. Добавь секретом Worker'а `api` с именем `ROUTINE_TOKEN_<SLUG>`, где `<SLUG>` — `slug` продукта из
       таблицы `projects` (например `ROUTINE_TOKEN_TEAM_CONSOLE`).

12. **`SLOT_TOKEN_<SLUG>_<SLOT>` и `SLOT_ROUTINE_<SLUG>_<SLOT>`** — «Запустить сейчас» из консоли (#114), по паре на
    каждый слот продукта (`<SLOT>`: `PM`, `DEV`, `QA`). Пока их нет, панель «Команды» показывает карточку настройки,
    а не ошибку; пауза и возобновление работают и без них.
    1. claude.ai/code/routines → рутина продукта `slot-pm` / `slot-dev` / `slot-qa` (если у слота несколько рутин —
       будничная) → добавь API-триггер. Токен (`sk-ant-oat01-…`) показывается один раз; id рутины (`trig_…`) — в
       адресе триггера.
    2. В своей копии репозитория team-console:
       `npx wrangler secret put SLOT_ROUTINE_<SLUG>_<SLOT> --env production --config apps/api/wrangler.jsonc` и
       `npx wrangler secret put SLOT_TOKEN_<SLUG>_<SLOT> --env production --config apps/api/wrangler.jsonc` —
       значение wrangler спросит скрытым вводом. Токен вставляй только туда — никогда в чат, issue или агенту; если
       он утёк, создай новый в Claude Code (старый перестанет работать).
    3. На `dev` / `stage` — только если хочешь проверить запуск оттуда: это те же настоящие рутины.

- [ ] Хостинг: не требуется отдельно — это Cloudflare Workers (см. выше).
- [ ] Аккаунт базы данных: не требуется отдельно — это Cloudflare D1 (см. шаг 6 выше).

## Секреты GitHub Actions (Settings → Environments → `dev` / `stage` / `production` → Environment secrets,
если не сказано иное)
| Секрет | Для чего (какой workflow) | Как завести | Окружения | Готово |
| ------ | -------------------------- | ------------ | --------- | ------ |
| `CLOUDFLARE_API_TOKEN` | `deploy.yml`: миграции D1, деплой обоих Worker'ов и Storybook | `tools/owner-setup/set-secrets.sh` (шаг 2, после шага 0 — роллинга токена) | dev, stage, production | [ ] (сейчас repository-level — шаги 2–3 переносят) |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.yml` | `tools/owner-setup/set-secrets.sh` (шаг 2) | dev, stage, production | [ ] (сейчас repository-level — шаги 2–3 переносят) |
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
| `VAPID_PUBLIC_KEY` | публичный VAPID-ключ, читает клиентский код (появится с #11) | шаг 4 выше, значение из вывода скрипта (шаг 2) | dev, stage, production — своё значение в каждом | [ ] |
| `ACCESS_TEAM_DOMAIN` | JWT-проверка Access в Worker'е `api` (ADR 0001 решение 7); `deploy.yml` передаёт её Worker'у через `--var`, это единственный источник (`wrangler.jsonc` в коде остаётся пустым нарочно) | шаг 7.8–7.9 выше | dev, stage, production | [ ] |
| `ACCESS_AUD` | то же самое | шаг 7.7, 7.9 выше | dev, stage, production | [ ] |
| `CONSOLE_GITHUB_APP_ID` | JWT-минтинг в Worker'е `api` (ADR 0003 решение 6); `deploy.yml` передаёт её Worker'у как `GITHUB_APP_ID` через `--var` (имя на стороне GitHub другое — см. шаг 10, GitHub не разрешает переменные с префиксом `GITHUB_`) | шаг 10 выше (`tools/owner-setup/create-apps.sh`) | dev, stage, production — своё значение в каждом | [ ] |
| `CONSOLE_GITHUB_APP_CLIENT_ID` | OAuth-обмен кода на токен владельца (ADR 0003 решение 3); `deploy.yml` передаёт Worker'у как `GITHUB_APP_CLIENT_ID` через `--var` | шаг 10 выше | dev, stage, production — своё значение в каждом | [ ] |
| `OWNER_GITHUB_LOGIN` | сверка входящего логина при OAuth-коллбэке (ADR 0003 решение 3); `deploy.yml` передаёт через `--var` | шаг 10 выше (твой логин, полученный через `gh`) | dev, stage, production | [ ] |

## Секреты самих Worker'ов (Cloudflare, не GitHub — либо `tools/owner-setup/set-secrets.sh`, либо `wrangler
secret put` / dashboard → Workers & Pages → Worker → Settings → Variables and Secrets)
| Секрет | Worker | Для чего | Как завести | Окружения | Готово |
| ------ | ------ | -------- | ------------ | --------- | ------ |
| `OWNER_EMAIL` | `api` | проверка JWT от Access (ADR 0001 решение 7) | шаг 9 выше (вручную) | dev, stage, production | [ ] |
| `VAPID_PRIVATE_KEY` | `api`, `hooks` | веб-пуш (ADR 0001 решение 11) | `tools/owner-setup/set-secrets.sh` (шаг 2) — своя пара на каждое окружение | dev, stage, production | [ ] |
| `WEBHOOK_SECRET` | `hooks` | подпись `X-Hub-Signature-256` входящих вебхуков (ADR 0003 решение 5); значение — собственный webhook secret консольного GitHub App'а этого окружения | шаг 10 выше (`tools/owner-setup/create-apps.sh`) | dev, stage, production — своя пара приложение/секрет на каждое | [ ] |
| `GITHUB_APP_PRIVATE_KEY` | `api` | минтинг JWT/installation-токенов для GitHub API (ADR 0003 решения 2, 6; заменяет `GITHUB_TOKEN` из ADR 0001 решения 6 — этого секрета больше нет) | шаг 10 выше — приватный ключ приложения, сконвертированный скриптом в PKCS#8 | dev, stage, production | [ ] |
| `GITHUB_APP_CLIENT_SECRET` | `api` | обмен OAuth-кода на токен владельца (ADR 0003 решение 3) | шаг 10 выше | dev, stage, production | [ ] |
| `TOKEN_ENCRYPTION_KEY` | `api` | шифрует пару токенов владельца в D1 (ADR 0003 решение 4) | шаг 10 выше — генерируется скриптом, 32 случайных байта | dev, stage, production — свой ключ на каждое | [ ] |
| `ROUTINE_TOKEN_<SLUG>` | `api` | будит routine PM-чата продукта `<slug>` (ADR 0001 решение 11) | шаг 11 выше | по одному на продукт, когда появится соответствующая задача | [ ] |
| `SLOT_TOKEN_<SLUG>_<SLOT>` | `api` | bearer API-триггера рутины слота (`PM` / `DEV` / `QA`) для «Запустить сейчас» (#114) | шаг 12 выше | production (dev/stage — по желанию); по одному на слот продукта | [ ] |
| `SLOT_ROUTINE_<SLUG>_<SLOT>` | `api` | id этой рутины (`trig_…`), чтобы он не лежал в публичном репозитории | шаг 12 выше | там же, где токен слота | [ ] |

## Усиление безопасности (сделать желательно до первого релиза)

По умолчанию каждый агент действует от твоего GitHub-аккаунта: merge gate и твои комментарии `/approve`, `/go`
— это соглашение, которое агент в принципе может имитировать (в инбоксе висит пункт "Security setup", пока
это не сделано).

1. **Отдельный аккаунт-ревьюер.** Заведи GitHub machine account (один бесплатный machine account на человека
   разрешён). Дай ему write-доступ к этому репозиторию, без admin. Создай для него fine-grained токен: только
   этот репозиторий, Pull requests read/write, Contents read, Issues read. Впиши его логин в
   `team.reviewer_logins` в `.product-team/project.yml` — с этого момента только его вердикты учитывает
   `scripts/pr gate`.
2. **Отдельное cloud-окружение для ревью.** В claude.ai/code создай окружение `reviewers` с переменной
   `PT_REVIEW_TOKEN` = этот токен, и направь на него routine `slot-qa`. `slot-pm` и `slot-dev` оставь в
   окружении по умолчанию, где токена ревьюера нет — так агент-разработчик не сможет выставить засчитываемый
   вердикт. (Роли внутри одной сессии делят токены этой сессии; разделение работает только между
   окружениями.)
3. **Свои собственные команды.** Пока GitHub-личность агентов — это твой аккаунт, агент может написать
   комментарий, похожий на твой; поэтому команда принимает release **go** только со страницы демо или из
   комментария старше текущего запуска. Полное разделение появится только вместе с агентами на собственной
   идентичности.
4. **Серверное принуждение (стоит денег или публичности).** Правила (rulesets), требующие ревью от аккаунта-
   ревьюера, недоступны для приватных репозиториев на бесплатном плане GitHub. Варианты: GitHub Pro (платно —
   нужен твой `/approve` на вопрос о бюджете) или сделать репозиторий публичным. До этого `branch-guard.yml`
   постфактум сообщает о любом изменении, попавшем в `dev`, `stage` или `main` без смёрженного PR.

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
