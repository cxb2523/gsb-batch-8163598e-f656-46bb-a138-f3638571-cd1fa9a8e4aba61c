import {spawn} from 'node:child_process';
import {readFile,writeFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);
const [major,minor]=process.versions.node.split('.').map(Number);
if (!((major===20&&minor>=19)||(major===22&&minor>=12)||major>22)) {
  console.error('Please install a current Node.js LTS version (20.19+ or 22.12+).');
  process.exit(1);
}
function npm(args) {
  return new Promise((resolve,reject)=>{
    // Only fixed commands and a validated numeric port are passed to cmd.
    const child=process.platform==='win32'
      ? spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c','npm.cmd '+args.join(' ')],{cwd:root,stdio:'inherit',windowsHide:true})
      : spawn('npm',args,{cwd:root,stdio:'inherit'});
    child.on('error',reject);
    child.on('exit',(code,signal)=>code===0||signal==='SIGINT'?resolve():reject(new Error('Command exited with code '+code)));
  });
}
try {
  const hash=createHash('sha256').update(await readFile('package-lock.json')).digest('hex');
  const marker='node_modules/.fold-studio-lock';
  let ready=false;
  try {
    ready=(await readFile(marker,'utf8'))===hash;
    await access('node_modules/vite/bin/vite.js');
    await access('node_modules/three/package.json');
    await access('node_modules/jspdf/package.json');
    await access('node_modules/polygon-clipping/package.json');
  } catch { ready=false; }
  if (!ready) {
    console.log('First run or updated dependencies: installing libraries automatically. Internet is required.');
    await npm(['ci']);
    await writeFile(marker,hash);
  }
  if (!process.argv.includes('--install-only')) {
    const port=process.env.FOLD_STUDIO_PORT||'4189';
    if (!/^\d{4,5}$/.test(port)||Number(port)>65535) throw new Error('FOLD_STUDIO_PORT must be a valid port number.');
    console.log('Fold Studio: open http://127.0.0.1:'+port+'/ — press Ctrl+C to stop.');
    await npm(['run','dev','--','--port',port,'--strictPort']);
  }
} catch(error) {
  console.error('Fold Studio could not start: '+error.message);
  console.error('Check your internet connection, Node.js installation and whether the port is already in use.');
  process.exitCode=1;
}
