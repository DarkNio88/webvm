import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
	optimizeDeps: {
		esbuildOptions: {
			target: "es2022",
			supported: { "top-level-await": true }
		}
	},
	resolve: {
		alias: {
			'/config_terminal': process.env.WEBVM_MODE == "github" ? 'config_github_terminal.js' : 'config_public_terminal.js',
			// Host the CheerpX runtime locally (no leaningtech.com CDN)
			"@leaningtech/cheerpx": '/cx-runtime/cx.esm.js'
		}
	},
	build: {
		target: "es2022"
	},
	plugins: [
		sveltekit(),
		viteStaticCopy({
			targets: [
				{ src: 'tower.ico', dest: '' },
				{ src: 'scrollbar.css', dest: '' },
				{ src: 'serviceWorker.js', dest: '' },
				{ src: 'login.html', dest: '' },
				{ src: 'assets/', dest: '' },
				{ src: 'documents/', dest: '' },
				{ src: 'tun/*', dest: 'tun' },
				{ src: 'cx-runtime/**', dest: 'cx-runtime' },
				{ src: 'cx-runtime/*.{js,wasm}', dest: '' }
			]
		})
	]
});
