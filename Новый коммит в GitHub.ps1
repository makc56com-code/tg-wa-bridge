# ���������, ���� �� ���������
if (git diff-index --quiet HEAD --) {
    Write-Host "��� ��������� ��� �������"
} else {
    git add .
    git commit -m "Fix Telegram source entity handling and add logging"
    git push
}
