# ������� � �����, ��� ����� ������
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

# ������ Node.js �������
node index.js

# �������� ���� �������� ����� ���������� (�����������)
Write-Host "������ ��������. ������� Enter ��� ������..."
Read-Host
