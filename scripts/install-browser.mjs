import { installCompatibleChrome } from '../dist/index.js';

const browser = await installCompatibleChrome({ downloadProgress: 'default' });

console.log(browser.executablePath);
