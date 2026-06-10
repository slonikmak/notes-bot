# notes-bot

Телеграм-бот для быстрых заметок: темы + заметки (текст / голос / пересланные сообщения) + HTTP API.
TypeScript, grammY, better-sqlite3, Groq Whisper. Один процесс, база — файл `notes.db`.

## Как пользуешься

1. `/topics` → тап по теме → она становится **активной**.
2. Дальше просто кидаешь в чат что угодно: текст, голосовые, форварды из других чатов.
   Каждое сообщение — заметка в активную тему. Подтверждение — реакция ✍ на сообщении.
3. Голос распознаётся (Groq Whisper) и показывается **превью** с кнопками:
   💾 Сохранить / ✖ Отмена / 📋 Скопировать для правки (кладёт текст в буфер; кнопка есть при тексте до 256 символов — лимит Telegram).
   Либо просто шлёшь исправленный текст следующим сообщением — сохранится он.
   Reply на конкретное превью правит именно его (если надиктовал несколько войсов подряд).
4. У форварда сохраняется полный текст + источник (канал/чат/юзер). Форвард с войсом — тоже через превью.

Темы: создать, переименовать, удалить — кнопками. У каждого пользователя свои темы и заметки.

## Запуск

```powershell
npm install
copy .env.example .env   # и заполнить
npm run dev              # разработка (ts-node)
```

Прод: `npm run build && npm start`.

### .env

| Переменная | Зачем |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен от [@BotFather](https://t.me/BotFather) |
| `ALLOWED_USER_IDS` | id юзеров через запятую; пусто — пускать всех |
| `GROQ_API_KEY` | распознавание голоса ([console.groq.com](https://console.groq.com)); пусто — войсы отключены |
| `API_KEY` | секрет для HTTP API; пусто — API выключен |
| `API_PORT` | порт API, по умолчанию 3000 |

Свой телеграм-id не знаешь — напиши боту без `ALLOWED_USER_IDS`: при закрытом доступе бот его подсказывает, либо спроси у [@userinfobot](https://t.me/userinfobot).

## HTTP API

Все запросы — с заголовком `X-API-Key: <API_KEY>`.

```powershell
# темы (фильтр по юзеру опционален)
curl -H "X-API-Key: secret" "http://localhost:3000/api/topics?user_id=123"

# заметки: всё текстом — голос уже распознан, форварды полным текстом + источник
curl -H "X-API-Key: secret" "http://localhost:3000/api/notes?user_id=123&topic_id=1&since=2026-06-01T00:00:00"

# добавить заметку извне
curl -X POST -H "X-API-Key: secret" -H "Content-Type: application/json" `
  -d '{"topic_id": 1, "text": "заметка из скрипта"}' http://localhost:3000/api/notes
```

Формат заметки:

```json
{
  "id": 42,
  "topic_id": 1,
  "topic_name": "ИИ",
  "user_id": 123456789,
  "source_type": "voice",        // text | voice | forward | api
  "text": "распознанный текст",
  "forward_from": "канал «X» (@x)",  // только у форвардов
  "created_at": "2026-06-10 12:34:56" // UTC
}
```

`since` принимает `2026-06-10T12:00:00` или `2026-06-10 12:00:00` (UTC).

## Структура

```
src/
  index.ts       запуск: бот + API
  config.ts      env
  db.ts          SQLite: темы, заметки, активная тема, выборки для API
  bot.ts         grammY: UX, голос, форварды
  transcribe.ts  Groq Whisper
  api.ts         HTTP API (node:http, без фреймворка)
```
