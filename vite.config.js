import {defineConfig} from 'vite';
export default defineConfig({server:{watch:{ignored:['**/output/**','**/upstream/**']}},build:{rollupOptions:{output:{manualChunks:{three:['three'],pdf:['jspdf']}}}}});
