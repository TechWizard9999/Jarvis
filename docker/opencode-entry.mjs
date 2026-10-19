import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const config = JSON.parse(readFileSync('/agent/opencode.json', 'utf8'));
const provider = config.model.split('/')[0];
const env = { ...process.env, OPENCODE_SERVER_PASSWORD: readFileSync('/run/bugfix-secrets/server_password','utf8').trim(),
  NVIDIA_API_KEY: config.provider[provider].options.apiKey };
const child = spawn('opencode', ['web','--hostname','0.0.0.0','--port','4096'], { stdio:'inherit', env });
process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));
child.on('exit',code=>process.exit(code ?? 1)); child.on('error',error=>{console.error(error.message);process.exit(1);});
