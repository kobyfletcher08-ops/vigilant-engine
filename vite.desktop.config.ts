import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
export default defineConfig({root:resolve('desktop'),publicDir:resolve('public'),plugins:[react()],resolve:{alias:{'@':resolve('.')}},build:{outDir:resolve('desktop-package/client'),emptyOutDir:true,target:'chrome130',chunkSizeWarningLimit:1600},css:{postcss:resolve('.')}});
