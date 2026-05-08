# Telegram Panel

Telegram Panel - локальная веб-панель для работы с Telegram-аккаунтами через Telethon. Проект запускает FastAPI-сервер, открывает браузерную панель и позволяет управлять чатами, контактами, профилем аккаунта, медиа, приватностью и состояниями аккаунтов из одного интерфейса.

Панель рассчитана на локальное использование. Файлы сессий, логи, персональные настройки интерфейса и загруженные фоновые медиа не должны попадать в публичный репозиторий.

## Возможности

- Подключение нескольких Telegram-аккаунтов из папки `accounts/`.
- Автоматическая проверка аккаунта через `@SpamBot` при подключении.
- Скрытие проблемных аккаунтов с переносом в отдельные папки: `accounts/dead/`, `accounts/frozen/`, `accounts/time_sb/`, `accounts/immortal_sb/`.
- Список чатов и контактов с обновлением в реальном времени.
- Ghost-mode: режим чтения без отметки сообщений как прочитанных.
- Отправка сообщений и отображение понятных ошибок Telegram API с сохранением исходного кода ошибки.
- Просмотр медиа в чатах: фото, видео, GIF/документы, аудио, голосовые сообщения и контакты.
- Переход из чата в профиль пользователя, добавление, изменение и удаление контактов.
- Удаление чатов с пользователями, если Telegram разрешает удаление для обеих сторон.
- Управление фото профиля аккаунта: очередь нескольких фото, предпросмотр, порядок загрузки, прогресс и удаление всех фото.
- Настройки приватности аккаунта, включая пункт "Кто может отправлять мне сообщения".
- Кастомизация интерфейса: темная/светлая тема, фон PNG/JPG/MP4, прозрачные панели.
- Локализация RU/EN.
- Подробное логирование действий в `logs.log`.

## Требования

- Windows 10/11.
- Python 3.10 или новее.
- Установленный браузер. `run.bat` сначала пробует открыть Chrome в режиме инкогнито, затем Edge, Brave, Firefox или системный браузер.
- Telegram `.session` файлы для аккаунтов, которые нужно подключать.

## Установка

1. Скачай или клонируй проект.

```powershell
git clone https://github.com/whatisdantes/telegram-panel.git
cd telegram-panel
```

2. Создай виртуальное окружение.

```powershell
python -m venv .venv
.\.venv\Scripts\activate
```

3. Установи зависимости.

```powershell
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

4. При необходимости создай `.env` на основе `.env.example`.

```powershell
copy .env.example .env
```

Если `.env` не создан, проект использует значения по умолчанию из `app/config.py`.

## Настройка `.env`

Основные параметры:

```env
API_ID=2040
API_HASH=b18441a1ff607e10a989891a5462e627
SESSIONS_DIR=accounts
HOST=0.0.0.0
PORT=8080
LOG_LEVEL=INFO
```

Также в проекте используются параметры подключения Telegram-клиента:

```env
DEVICE_MODEL=Asus TUF
APP_VERSION=6.7.5 x64
SYSTEM_VERSION=Windows 11 x64
LANG_CODE=ru
SYSTEM_LANG_CODE=ru-RU
```

Обычно их можно не менять, если текущие значения подходят.

## Подготовка аккаунтов

1. Создай папку `accounts/`, если ее еще нет.
2. Помести в нее `.session` файлы аккаунтов.
3. Запусти панель и подключи нужный аккаунт в правой панели.

Проблемные аккаунты панель переносит автоматически:

- `accounts/dead/` - неавторизованные сессии.
- `accounts/frozen/` - аккаунты, замороженные по ответу `@SpamBot`.
- `accounts/time_sb/` - аккаунты с временным спамблоком.
- `accounts/immortal_sb/` - аккаунты с вечным спамблоком.

Если старые `.session` файлы имеют несовместимую структуру, можно один раз запустить конвертацию:

```powershell
python convert_sessions.py
```

## Запуск

Самый простой способ на Windows:

```powershell
.\run.bat
```

`run.bat` запускает сервер и открывает панель по адресу `http://localhost:8080/` в приватном режиме браузера, чтобы старый кэш интерфейса не мешал работе.

Ручной запуск:

```powershell
python run.py
```

После запуска открой:

```text
http://localhost:8080/
```

Остановить сервер можно закрытием окна консоли или сочетанием `Ctrl+C`.

## Локальные Файлы

Эти файлы и папки являются локальными и не должны попадать в GitHub:

- `accounts/` - Telegram-сессии аккаунтов.
- `logs.log` - подробные логи работы панели.
- `ui_customization.json` - персональные настройки интерфейса.
- `app/static/customization/` - загруженные фоновые изображения и видео.
- `__pycache__/` и другие кэши Python.

Они уже добавлены в `.gitignore`.

## Проверка Перед Коммитом

Перед `git add`, `git commit` и `git push` полезно выполнить:

```powershell
python -m compileall app
node --check app/static/js/app.js
node --check app/static/js/accounts.js
node --check app/static/js/chat.js
node --check app/static/js/profile.js
git diff --check
git status --short --ignored
```

В `git status --short --ignored` локальные данные должны быть отмечены как ignored, например `!! accounts/`, `!! logs.log`, `!! ui_customization.json`.

## Частые Проблемы

### Открывается старая версия интерфейса

Обычно причина в кэше браузера. Запускай панель через `run.bat`: он добавляет cache-busting параметр к URL и открывает браузер в приватном режиме.

### Аккаунт пропал из панели

Проверь папки `accounts/dead/`, `accounts/frozen/`, `accounts/time_sb/` и `accounts/immortal_sb/`. Панель переносит туда аккаунты, которые не авторизованы или получили проблемный статус от `@SpamBot`.

### Ошибка Telethon `TypeNotFoundError`

Чаще всего помогает перезапуск панели. Если ошибка повторяется, проверь версию Telethon:

```powershell
python -m pip show telethon
python -m pip install --upgrade telethon
```

### Медиа не отображается

Проверь `logs.log`. Если Telegram прислал неизвестный или неподдерживаемый тип медиа, панель должна показать fallback-карточку файла, а не ломать чат.

## Структура Проекта

```text
app/
  api/              FastAPI endpoints
  models/           Pydantic schemas
  static/           HTML, CSS, JS веб-панели
  telegram/         Telethon client manager, utils, error mapping
accounts/           Локальные Telegram-сессии, не коммитить
run.py              Запуск uvicorn-сервера
run.bat             Запуск сервера и браузера
requirements.txt    Python-зависимости
```
