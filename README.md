# Telegram Panel

Локальная веб-панель для работы с уже существующими Telegram `.session` через FastAPI + Telethon.

Проект поднимает браузерный интерфейс без build-шага, сканирует папку `accounts/`, подключает найденные сессии и позволяет работать с диалогами, сообщениями, профилем и частью настроек приватности.

## Что умеет сейчас

- Подключать и переподключать существующие `.session`
- Показывать список аккаунтов в отдельной правой панели с поиском, статусами и аватарками
- Открывать диалоги, читать историю и получать новые сообщения в реальном времени через WebSocket
- Отправлять текстовые сообщения
- Удалять приватный чат с пользователем у обеих сторон
- Отображать медиа в чате:
  - фото
  - видео
  - аудио и voice
  - файлы
  - контактные карточки с переходом в диалог
- Показывать аватарки пользователей и аккаунтов
- Искать собеседника по `@username`, номеру телефона или `user_id`
- Открывать профиль собеседника прямо из чата и добавлять его в контакты
- Добавлять найденного через `Open New Chat` пользователя в контакты
- Редактировать профиль:
  - `first_name`
  - `last_name`
  - `username`
  - фото профиля
  - загрузку одной фотографии
  - загрузку нескольких фотографий очередью с ручным порядком
  - удаление всех фото профиля
- Читать и менять базовые настройки приватности:
  - `Last seen & online`
  - `Phone number`
  - `Profile photo`
  - `Forwarded messages`
  - `Groups & channels`
  - `Calls`
- Вести подробный лог всех HTTP/WebSocket и ключевых Telegram-действий в `logs.log`

## Важная логика при подключении

При каждом `connect/reconnect` аккаунт после успешной авторизации автоматически пишет `/start` в `@SpamBot`.

Если по ответу `@SpamBot` определяется проблема, сессия убирается из панели и переносится в отдельную папку:

- `accounts/dead/`
  - неавторизованная сессия
  - требуется 2FA для этой сессии
- `accounts/frozen/`
  - блокировка за нарушение Telegram Terms of Service
- `accounts/time_sb/`
  - временный спамблок
- `accounts/immortal_sb/`
  - вечный спамблок

После переноса аккаунт больше не отображается в веб-интерфейсе.

## Стек

| Компонент | Используется |
|-----------|--------------|
| Backend | FastAPI |
| Telegram API | Telethon |
| Frontend | Vanilla JS + CSS |
| Realtime | WebSocket |
| Конфиг | `pydantic-settings` + `.env` |
| Работа с файлами | `python-multipart`, `aiofiles`, `Pillow` |

## Структура проекта

```text
telegram-panel/
├── .env.example
├── convert_sessions.py
├── download_libraries.bat
├── logs.log
├── README.md
├── requirements.txt
├── run.bat
├── run.py
├── accounts/
│   ├── dead/
│   ├── frozen/
│   ├── immortal_sb/
│   └── time_sb/
└── app/
    ├── config.py
    ├── logging_setup.py
    ├── main.py
    ├── api/
    │   ├── accounts.py
    │   ├── messages.py
    │   ├── profile.py
    │   └── ws.py
    ├── models/
    │   └── schemas.py
    ├── static/
    │   ├── index.html
    │   ├── css/style.css
    │   └── js/
    │       ├── accounts.js
    │       ├── app.js
    │       ├── chat.js
    │       ├── profile.js
    │       └── ws.js
    └── telegram/
        ├── client_manager.py
        ├── error_map.py
        └── utils.py
```

Дополнительно во время работы создаются технические папки:

- `accounts/_media_cache/` — кэш скачанных медиа
- `accounts/_avatar_cache/` — кэш аватарок

## Скрипты в корне

### `run.py`

Основная точка входа. Запускает `uvicorn` c приложением `app.main:app`.

### `run.bat`

Windows-обёртка над `py run.py`.

### `download_libraries.bat`

Быстрая установка зависимостей:

```bat
pip install -r requirements.txt
```

### `convert_sessions.py`

Одноразовый служебный скрипт для конвертации старых `.session` SQLite-файлов из 6-колоночной схемы в 5-колоночную схему Telethon.

Запуск:

```bat
py convert_sessions.py
```

Нужен только если сессии были подготовлены в несовместимом формате.

## API

### Аккаунты `/api/accounts`

| Method | Endpoint | Описание |
|--------|----------|----------|
| GET | `/` | Список доступных аккаунтов |
| POST | `/{session_name}/connect` | Подключить аккаунт |
| POST | `/{session_name}/disconnect` | Отключить аккаунт |
| POST | `/{session_name}/reconnect` | Переподключить аккаунт |
| GET | `/{session_name}/status` | Текущий статус аккаунта |
| GET | `/{session_name}/me` | Информация о текущем пользователе |

### Сообщения `/api/messages`

| Method | Endpoint | Описание |
|--------|----------|----------|
| GET | `/{session_name}/dialogs` | Последние диалоги |
| GET | `/{session_name}/history/{entity_id}` | История сообщений |
| DELETE | `/{session_name}/dialog/{entity_id}` | Удалить приватный чат у обеих сторон |
| POST | `/{session_name}/send` | Отправить текстовое сообщение |
| POST | `/{session_name}/resolve` | Разрешить `username / phone / id` в entity |
| GET | `/{session_name}/user/{entity_id}` | Информация о пользователе/сущности |
| POST | `/{session_name}/user/{entity_id}/contact` | Добавить пользователя в контакты |
| GET | `/{session_name}/user/{entity_id}/avatar` | Аватар сущности |
| GET | `/{session_name}/media/{entity_id}/{message_id}` | Медиа конкретного сообщения |

### Профиль `/api/profile`

| Method | Endpoint | Описание |
|--------|----------|----------|
| PUT | `/{session_name}/update` | Обновить имя / фамилию / username |
| GET | `/{session_name}/avatar` | Текущее главное фото аккаунта |
| POST | `/{session_name}/avatar` | Загрузить одну новую фотографию профиля |
| POST | `/{session_name}/avatar/batch` | Загрузить несколько фото профиля по порядку |
| DELETE | `/{session_name}/avatar` | Удалить все фото профиля |
| GET | `/{session_name}/privacy` | Прочитать поддерживаемые privacy-настройки |
| PUT | `/{session_name}/privacy` | Обновить базовые privacy-настройки |

### WebSocket

| Endpoint | Назначение |
|----------|------------|
| `/ws` | Глобальные события всех аккаунтов |
| `/ws/{session_name}` | События конкретного аккаунта |

Текущие типы событий:

- `new_message`
- `status_change`
- `typing`
- `error`

## Статусы аккаунтов

Менеджер использует такие статусы:

- `connected`
- `disconnected`
- `unauthorized`
- `frozen`
- `temporary_spamblock`
- `permanent_spamblock`
- `invalid_session`
- `reconnecting`
- `error`

Часть статусов видна только как результат операции подключения, потому что после карантина аккаунт удаляется из активного списка.

## Конфигурация

Настройки читаются через `app/config.py`.

Поддерживаемые переменные:

```ini
API_ID=2040
API_HASH=b18441a1ff607e10a989891a5462e627
DEVICE_MODEL=Asus TUF
APP_VERSION=6.7.5 x64
SYSTEM_VERSION=Windows 11 x64
LANG_CODE=ru
SYSTEM_LANG_CODE=ru-RU
SESSIONS_DIR=accounts
HOST=0.0.0.0
PORT=8080
LOG_LEVEL=INFO
LOG_FILE=logs.log
```

Важно:

- `API_ID`, `API_HASH` и параметры client fingerprint уже имеют значения по умолчанию в коде
- при необходимости их можно переопределить через `.env`
- `LOG_FILE` по умолчанию указывает на `logs.log` в корне проекта
- `.env.example` сейчас содержит базовый минимальный шаблон, недостающие поля можно добавить вручную

## Запуск

### Windows

```bat
download_libraries.bat
run.bat
```

### Универсальный вариант

```bash
python -m venv venv
venv\Scripts\activate          # Windows
# source venv/bin/activate     # Linux/macOS
pip install -r requirements.txt
python run.py
```

После запуска откройте:

```text
http://localhost:8080
```

## Подготовка сессий

Поместите готовые `.session` в папку `accounts/`.

Пример:

```text
accounts/
  my_account.session
  second_account.session
```

Если часть старых сессий не читается из-за несовместимой SQLite-схемы, прогоните:

```bat
py convert_sessions.py
```

## Ограничения и особенности

- Панель работает только с уже существующими `.session`
- Создание новых сессий через номер телефона пока не реализовано
- Ввод 2FA-пароля из UI не реализован
- Отправка медиа из интерфейса пока не реализована
- Удаление чата у обеих сторон поддерживается только для приватных диалогов с пользователями
- Добавление в контакты доступно только для обычных пользователей
- Privacy-редактор меняет только базовый режим
  - если у настройки уже есть исключения, при сохранении они будут заменены
- На старте приложение только сканирует `accounts/`
  - проверка `@SpamBot` происходит при подключении / переподключении

## Безопасность и эксплуатация

Текущее состояние проекта:

- панель не имеет собственной аутентификации
- CORS открыт на `*`
- `.session` лежат на локальном диске рядом с приложением
- подробные действия приложения пишутся в `logs.log`
- ошибки API отдаются в безопасном виде, подробности пишутся в лог

Для использования вне локальной машины стоит как минимум добавить:

- аутентификацию
- HTTPS
- ограничение CORS
- отдельное хранение конфигурации и сессий

## Что уже неактуально из старых описаний

В текущем проекте уже поддерживаются вещи, которые раньше были только в планах:

- отображение аватарок
- просмотр медиа в чате
- работа с `MessageMediaContact`
- редактирование базовых privacy-настроек
- автоматическая quarantine-логика для проблемных аккаунтов
- открытие профиля человека из чата и добавление в контакты
- пакетная загрузка фото профиля с очередью и порядком
- удаление приватного чата у обеих сторон
- подробное файловое логирование в `logs.log`

## Куда смотреть в коде

- [app/main.py](app/main.py) — инициализация FastAPI и lifespan
- [app/logging_setup.py](app/logging_setup.py) — централизованная настройка логирования в `logs.log`
- [app/telegram/client_manager.py](app/telegram/client_manager.py) — подключение аккаунтов, статусы, `@SpamBot`, quarantine
- [app/api/messages.py](app/api/messages.py) — диалоги, история, медиа, resolve, контакты, удаление чатов
- [app/api/profile.py](app/api/profile.py) — профиль, фотографии профиля, privacy
- [app/static/js/accounts.js](app/static/js/accounts.js) — UI списка аккаунтов
- [app/static/js/chat.js](app/static/js/chat.js) — рендер сообщений, медиа и `Open New Chat`
- [app/static/js/profile.js](app/static/js/profile.js) — профиль, фото профиля, privacy и карточки пользователей
