# Google Sheets Telegram Bot

Telegram-бот для работы с Google Drive и Sheets. Поиск таблиц, синхронизация данных, автоматизация рутины с таблицами прямо из чата.

## Features

- Поиск таблиц по имени в Google Drive
- Синхронизация данных из таблиц (автоматическая нормализация, форматирование)
- Health-check Telegram + Google авторизации
- Авторизация через сервисный аккаунт (без пользовательского логина)
- Фоновый запуск через systemd

## Tech Stack

- Node.js
- Google Sheets API
- Google Drive API
- Telegram Bot API (long polling)

## Quick Start

```bash
cp .env.example .env
# Заполни токены в .env
node src/app.js
```

## Deploy

```bash
./scripts/install-systemd-service.sh
```
