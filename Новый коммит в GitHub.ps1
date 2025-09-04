# Проверяем, есть ли изменения
if (git diff-index --quiet HEAD --) {
    Write-Host "Нет изменений для коммита"
} else {
    git add .
    git commit -m "Fix Telegram source entity handling and add logging"
    git push
}
