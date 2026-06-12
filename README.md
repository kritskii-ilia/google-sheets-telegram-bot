# Google Sheets Telegram Bot

Узкий Telegram-first бот для работы с Google Drive / Sheets / Docs без `OpenClaw`.

## Что умеет

- `/start` и `/help`
- `/health` — проверка Telegram + Google auth
- `/gfind <название таблицы>` — поиск таблицы по имени в sandbox-папке
- `/gsalarysync <таблица> [| <лист>] [| <startRow>] [| <endRow>]`
- `/gsalarysync <папка > подпапка> | <таблица> | <лист> [| <startRow>] [| <endRow>]`

По salary sync бот:

- нормализует пробелы в `A:I`
- переносит значения из `H:I` в `A:B`
- сопоставляет по ФИО
- добавляет новых сотрудников
- сортирует список по алфавиту
- выравнивает новые ФИО по правому краю

## Структура

- `src/config.js` — env и валидация конфига
- `src/logger.js` — логи
- `src/google/` — Google auth + Drive + Sheets
- `src/telegram/` — Telegram API и polling
- `src/commands/` — команды бота
- `src/app.js` — точка входа
- `src/health.js` — health-check

## Запуск

```bash
cd /home/user/google-sheets-telegram-bot
cp .env.example .env
node src/app.js
```

## systemd

Для установки как сервиса используется:

`scripts/install-systemd-service.sh`
