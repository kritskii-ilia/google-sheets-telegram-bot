#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/user/google-sheets-telegram-bot"
SERVICE_NAME="google-sheets-telegram-bot.service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"

cat >"${SERVICE_PATH}" <<'EOF'
[Unit]
Description=Google Sheets Telegram Bot
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=30

[Service]
Type=simple
User=root
WorkingDirectory=/home/user/google-sheets-telegram-bot
ExecStart=/usr/bin/node /home/user/google-sheets-telegram-bot/src/app.js
ExecStartPost=/bin/bash -lc 'sleep 2 && timeout 25s /usr/bin/node /home/user/google-sheets-telegram-bot/src/health.js'
Restart=always
RestartSec=5
TimeoutStartSec=40
Environment=NODE_ENV=production
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"
systemctl status "${SERVICE_NAME}" --no-pager
