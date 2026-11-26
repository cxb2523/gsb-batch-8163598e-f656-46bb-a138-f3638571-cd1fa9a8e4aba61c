let connection;
function db(){return connection||=(new Promise((resolve,reject)=>{const r=indexedDB.open('fold-studio',1);r.onupgradeneeded=()=>r.result.createObjectStore('projects');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);}));}
export async function storeProject(value){const d=await db();await new Promise((res,rej)=>{const t=d.transaction('projects','readwrite');t.objectStore('projects').put(value,'current');t.oncomplete=res;t.onerror=()=>rej(t.error);});}
export async function loadProject(){const d=await db();return new Promise((res,rej)=>{const r=d.transaction('projects').objectStore('projects').get('current');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
