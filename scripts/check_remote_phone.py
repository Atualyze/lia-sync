import paramiko

try:
    k = paramiko.RSAKey.from_private_key_file(r'D:\Projetos\lia-assistente\ssh-key-2026-11-05.key')
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect('localhost', username='ubuntu', pkey=k, timeout=10)
    cmd = 'docker exec lia-bot node --input-type=module -e "import { getInstanceOwnerPhone } from \'./src/whatsapp.mjs\'; import { config } from \'./src/config.mjs\'; console.log(\'OWNER:\', await getInstanceOwnerPhone()); console.log(\'CONFIG HUMAN:\', config.humanPhone);"'
    stdin, stdout, stderr = ssh.exec_command(cmd)
    print("OUTPUT:")
    print(stdout.read().decode('utf-8', errors='ignore'))
    print("STDERR:", stderr.read().decode('utf-8', errors='ignore'))
    ssh.close()
except Exception as e:
    print("ERROR:", e)
