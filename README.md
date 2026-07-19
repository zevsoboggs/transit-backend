# transit-backend

Backend для панели управления транзитными кошельками:

- **Авторизация** (JWT) — пользователи в собственной PostgreSQL.
- **Своя БД** — хранит выпущенные кошельки (изоляция от чужих) и реестр операций.
- **Прокси к upstream `transit-api`** — ключ хранится только на сервере.
- **Суточный лимит** выпуска (по умолчанию 3000).
- **Ledger** — журнал всех операций (выпуск/пополнение/перевод/переименование).

## Запуск локально

```bash
cp .env.example .env   # заполни значения
npm install
npm start              # http://localhost:3001
```

## Деплой на Railway

1. Подключи этот репозиторий (`New Project → Deploy from GitHub → transit-backend`).
2. Railway сам определит Node и запустит `npm start` (порт берётся из `PORT` автоматически).
3. В **Variables** добавь переменные из `.env.example` (реальные значения):
   `PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, TRANSIT_API_ORIGIN,
   TRANSIT_API_KEY, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD,
   DAILY_WALLET_LIMIT, PANEL_PROJECT`.
4. **Settings → Networking → Custom Domain** → `transit-api.tranzor.io`,
   затем добавь выданный Railway CNAME в DNS домена.
5. Проверка: `https://transit-api.tranzor.io/health` → `{"ok":true}`.

При старте автоматически применяются миграции (`app_users`, `issued_wallets`,
`ledger`) и создаётся админ (`ADMIN_EMAIL` / `ADMIN_PASSWORD`), если его ещё нет.

## Эндпоинты

`POST /api/auth/login`, `GET /api/auth/me`, `GET /api/networks`, `GET /api/master`,
`GET /api/stats`, `GET /api/ledger`, CRUD `/api/wallets` (+ `/:id/balance`,
`/:id/topup`, `/:id/transfer`, `/:id/rename`). Всё, кроме `login`, требует
`Authorization: Bearer <token>`.
