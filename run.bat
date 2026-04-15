@echo off
start "" cmd /c python run.py
timeout /t 2 /nobreak >nul

set "URL=http://localhost:8080/?v=%RANDOM%%RANDOM%"

set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"

set "EDGE_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE_EXE%" set "EDGE_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

set "BRAVE_EXE=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
if not exist "%BRAVE_EXE%" set "BRAVE_EXE=%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe"

set "FIREFOX_EXE=%ProgramFiles%\Mozilla Firefox\firefox.exe"
if not exist "%FIREFOX_EXE%" set "FIREFOX_EXE=%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe"

if exist "%CHROME_EXE%" (
    start "" "%CHROME_EXE%" --incognito "%URL%"
    goto :eof
)

if exist "%EDGE_EXE%" (
    start "" "%EDGE_EXE%" --inprivate "%URL%"
    goto :eof
)

if exist "%BRAVE_EXE%" (
    start "" "%BRAVE_EXE%" --incognito "%URL%"
    goto :eof
)

if exist "%FIREFOX_EXE%" (
    start "" "%FIREFOX_EXE%" -private-window "%URL%"
    goto :eof
)

start "" "%URL%"
