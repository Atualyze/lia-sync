import os
import paramiko

KEY_FILE = r'D:\Projetos\lia-assistente\ssh-key-2026-11-05.key'
HOST = 'localhost'
USER = 'ubuntu'
REMOTE_DIR = '/home/ubuntu/lia-assistente'
LOCAL_SRC = r'D:\Projetos\lia-assistente\src'

print(f"Conectando a {USER}@{HOST}...")
k = paramiko.RSAKey.from_private_key_file(KEY_FILE)
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, pkey=k, timeout=15)
print("Conectado com sucesso!")

sftp = ssh.open_sftp()
print(f"Enviando arquivos de {LOCAL_SRC} para {REMOTE_DIR}/src...")

for f in os.listdir(LOCAL_SRC):
    if f.endswith('.mjs'):
        local_path = os.path.join(LOCAL_SRC, f)
        remote_path = f"{REMOTE_DIR}/src/{f}"
        sftp.put(local_path, remote_path)
        print(f" -> {f} atualizado")

sftp.close()

print("\nRebuildando e reiniciando o container docker no servidor remoto...")
cmd = f"cd {REMOTE_DIR} && docker compose up -d --build"
stdin, stdout, stderr = ssh.exec_command(cmd)
print("STDOUT:", stdout.read().decode('utf-8', errors='ignore'))
err = stderr.read().decode('utf-8', errors='ignore')
if err:
    print("STDERR:", err)

print("\nVerificando status do container...")
stdin, stdout, stderr = ssh.exec_command("docker ps --filter name=lia-bot")
print(stdout.read().decode('utf-8', errors='ignore'))

ssh.close()
print("\nDeploy concluído com sucesso!")
