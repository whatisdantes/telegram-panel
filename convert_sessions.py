"""
Одноразовый скрипт конвертации .session файлов из 6-колоночного формата
(dc_id, server_address, port, auth_key, takeout_id, tmp_auth_key)
в 5-колоночный формат Telethon
(dc_id, server_address, port, auth_key, takeout_id)

Запуск: py convert_sessions.py
"""

import sqlite3
import glob
import os

DIRS = ["accounts"]


def convert_session(path: str) -> str:
    """
    Возвращает: 'converted', 'skipped', 'empty', 'error:<msg>'
    """
    try:
        conn = sqlite3.connect(path)
        tables = [t[0] for t in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]

        if "sessions" not in tables:
            conn.close()
            return "empty"

        cols = [c[1] for c in conn.execute("PRAGMA table_info(sessions)").fetchall()]

        if len(cols) == 5:
            conn.close()
            return "skipped"

        if len(cols) != 6 or "tmp_auth_key" not in cols:
            conn.close()
            return f"skipped (unknown schema: {cols})"

        row = conn.execute(
            "SELECT dc_id, server_address, port, auth_key, takeout_id FROM sessions"
        ).fetchone()

        if row is None:
            conn.close()
            return "skipped (no rows)"

        dc_id, server_address, port, auth_key, takeout_id = row

        # takeout_id может быть b'' — приводим к None
        if isinstance(takeout_id, (bytes, bytearray)) and len(takeout_id) == 0:
            takeout_id = None

        conn.execute("DROP TABLE sessions")
        conn.execute("""
            CREATE TABLE sessions (
                dc_id INTEGER PRIMARY KEY,
                server_address TEXT,
                port INTEGER,
                auth_key BLOB,
                takeout_id INTEGER
            )
        """)
        conn.execute(
            "INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
            (dc_id, server_address, port, auth_key, takeout_id)
        )
        conn.commit()
        conn.close()
        return "converted"

    except Exception as e:
        return f"error:{e}"


def main():
    total = converted = skipped = empty = errors = 0

    for d in DIRS:
        if not os.path.exists(d):
            continue
        files = glob.glob(os.path.join(d, "*.session"))
        if not files:
            continue

        print(f"\n📁 {d}/ — {len(files)} файлов")
        for path in files:
            result = convert_session(path)
            total += 1
            if result == "converted":
                converted += 1
                print(f"  ✅ {os.path.basename(path)}")
            elif result == "empty":
                empty += 1
                print(f"  ⬜ {os.path.basename(path)} — пустой файл")
            elif result == "skipped":
                skipped += 1
                # не выводим — слишком много строк
            elif result.startswith("error:"):
                errors += 1
                print(f"  ❌ {os.path.basename(path)} — {result}")
            else:
                skipped += 1
                print(f"  ⚠️  {os.path.basename(path)} — {result}")

    print(f"\n{'='*50}")
    print(f"Итого файлов:    {total}")
    print(f"Сконвертировано: {converted}")
    print(f"Уже 5-колонок:   {skipped}")
    print(f"Пустых:          {empty}")
    print(f"Ошибок:          {errors}")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
