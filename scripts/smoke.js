import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildAuthUrl } from '../src/oauth.js';

const outDir = path.join(process.cwd(), 'recordings');
await fs.mkdir(outDir, { recursive: true });

const context = await chromium.launchPersistentContext(path.join(process.cwd(), 'profiles', 'smoke'), {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1280, height: 800 },
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--window-position=-3000,-3000',
    '--window-size=1280,890',
    '--no-first-run',
    '--disable-blink-features=AutomationControlled'
  ]
});

const page = context.pages()[0] || (await context.newPage());
await page.goto(buildAuthUrl('smoke'), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(outDir, 'smoke.png') });
console.log('url:', page.url());
console.log('email inputs:', await page.locator('input[type="email"], #identifierId').count());
await context.close();
