import { installBrowserShims } from './bootstrap.js';

installBrowserShims();
const { main } = await import('./run.js');
process.exitCode = await main(process.argv.slice(2));
