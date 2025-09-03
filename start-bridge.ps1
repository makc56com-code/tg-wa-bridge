# Перейти в папку, где лежит скрипт
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

# Запуск Node.js скрипта
node index.js

# Оставить окно открытым после завершения (опционально)
Write-Host "Скрипт завершен. Нажмите Enter для выхода..."
Read-Host
