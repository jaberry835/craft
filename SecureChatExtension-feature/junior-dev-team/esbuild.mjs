// @ts-check
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    sourcemap: !production,
    minify: production,
    treeShaking: true,
};

async function main() {
    if (watch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('[esbuild] watching for changes...');
    } else {
        const result = await esbuild.build(buildOptions);
        if (result.errors.length > 0) {
            console.error('[esbuild] build failed');
            process.exit(1);
        }
        console.log('[esbuild] build complete');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
