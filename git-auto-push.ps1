# Путь к репозиторию
$repoPath = "C:\Мост Telegram-WatsApp\В рендер\tg-wa-bridge"
Set-Location $repoPath

# Сообщение коммита
$commitMessage = "Fix Telegram source entity handling and add logging"

# Проверяем, есть ли изменения
if (git diff-index --quiet HEAD --) {
    Write-Host "✅ Нет изменений для коммита"
} else {
    git add .
    git commit -m $commitMessage
    Write-Host "💾 Коммит создан: $commitMessage"
}

# Проверяем, есть ли upstream
$upstream = git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>$null

if (!$upstream) {
    Write-Host "🌐 Ветка main не имеет upstream. Настраиваем привязку и пушим..."
    git push --set-upstream origin main
} else {
    Write-Host "🌐 Upstream уже настроен. Просто пушим..."
    git push
}

Write-Host "✅ Скрипт завершён."
