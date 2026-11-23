import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { buildAuthUrl, exchangeCodeForRefreshToken } from './oauth.js';
import { generateTotp, secondsRemaining } from './totp.js';

const WINDOW = { width: 1280, height: 800 };
const CALLBACK_PREFIX = process.env.REDIRECT_URI || `http://localhost:${Number(process.env.PORT) || 20000}/oauth-callback`;

const isCallback = page => page.url().startsWith(CALLBACK_PREFIX);
const isConsent = page => {
  try {
    return new URL(page.url()).pathname.includes('/consent');
  } catch {
    return false;
  }
};

const SELECTORS = {
  email: ['input[type="email"]', '#identifierId', 'input[name="identifier"]'],
  emailNext: ['#identifierNext', 'button:has-text("下一步")', 'button:has-text("Next")'],
  password: ['input[type="password"][name="Passwd"]', 'input[type="password"]'],
  passwordNext: ['#passwordNext', 'button:has-text("下一步")', 'button:has-text("Next")'],
  otherWay: [
    'button:has-text("尝试其他方式")',
    'button:has-text("Try another way")',
    '[role="button"]:has-text("尝试其他方式")',
    '[role="button"]:has-text("Try another way")'
  ],
  authenticator: [
    '[data-challengetype="6"]',
    'li:has-text("身份验证器")',
    'div[role="link"]:has-text("身份验证器")',
    '[role="button"]:has-text("身份验证器")',
    'li:has-text("Authenticator")',
    'div[role="link"]:has-text("Authenticator")',
    '[role="button"]:has-text("Authenticator")'
  ],
  totpInput: ['#totpPin', 'input[name="totpPin"]', 'input[type="tel"]', 'input[autocomplete="one-time-code"]'],
  totpNext: ['#totpNext', 'button:has-text("下一步")', 'button:has-text("Next")', 'button:has-text("验证")', 'button:has-text("Verify")'],
  consent: [
    '#submit_approve_access',
    'button:has-text("继续")',
    'button:has-text("允许")',
    'button:has-text("Continue")',
    'button:has-text("Allow")',
    'button:has-text("Login")',
    'button:has-text("Masuk")'
  ]
};

async function firstVisible(page, selectors, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    await page.waitForTimeout(200);
  }
  return null;
}

async function clickFirst(page, selectors, timeout = 15000) {
  const locator = await firstVisible(page, selectors, timeout);
  if (!locator) return false;
  await locator.click({ timeout: 5000 }).catch(() => {});
  return true;
}

async function typeInto(page, locator, value) {
  await locator.click({ timeout: 5000 }).catch(() => {});
  await locator.pressSequentially(value, { delay: 60 });
  await page.waitForTimeout(400);
}

async function submit(page) {
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
}

export async function extractRefreshToken(account, options) {
  const { recordingsDir, profilesDir, onStage, waitForCode, onPage } = options;
  await fs.mkdir(recordingsDir, { recursive: true });
  const profileDir = path.join(profilesDir, account.id);
  await fs.mkdir(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: WINDOW,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--window-position=-3000,-3000',
      `--window-size=${WINDOW.width},${WINDOW.height + 90}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=OptimizationHints,Translate'
    ]
  });

  const page = context.pages()[0] || (await context.newPage());
  if (onPage) onPage(page);

  await context
    .newCDPSession(page)
    .then(async session => {
      const { windowId } = await session.send('Browser.getWindowForTarget');
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    })
    .catch(() => {});

  try {
    onStage('打开登录页');
    await page.goto(buildAuthUrl(account.state), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const emailInput = await firstVisible(page, SELECTORS.email, 20000).catch(() => null);
    if (!emailInput) {
      onStage('切换账号选择');
      const switched = await clickFirst(page, [
        'div[role="link"]:has-text("使用其他账号")',
        'li:has-text("使用其他账号")',
        'div[role="link"]:has-text("Use another account")',
        'li:has-text("Use another account")'
      ], 8000);
      if (!switched) throw new Error('未找到邮箱输入框（登录页结构异常）');
    }

    const emailField = (await firstVisible(page, SELECTORS.email, 20000)) || null;
    if (!emailField) throw new Error('未找到邮箱输入框');
    onStage('填写邮箱');
    await typeInto(page, emailField, account.email);
    await submit(page);

    onStage('填写密码');
    const passwordField = await firstVisible(page, SELECTORS.password, 25000);
    if (!passwordField) throw new Error('未找到密码输入框（可能邮箱有误或被风控）');
    await typeInto(page, passwordField, account.password);
    await submit(page);

    onStage('等待二次验证');
    const totpInput = await waitForTotpStep(page, onStage);
    if (!totpInput) throw new Error('未进入身份验证器验证步骤');

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (secondsRemaining(account.twofa) <= 2) await page.waitForTimeout(2500);
      const code = generateTotp(account.twofa);
      onStage(`填写 2FA 验证码（第 ${attempt} 次）`);
      const field = (await firstVisible(page, SELECTORS.totpInput, 5000)) || totpInput;
      await typeInto(page, field, code);
      await submit(page);

      const outcome = await waitTotpOutcome(page);
      if (outcome !== 'retry') break;
      if (attempt === 3) throw new Error('2FA 验证码连续校验失败');
    }

    onStage('处理授权同意页');
    for (let i = 0; i < 12; i += 1) {
      if (isCallback(page)) break;
      const clicked = await clickFirst(page, SELECTORS.consent, 2500);
      if (!clicked) {
        await page.waitForTimeout(700);
        if (isCallback(page)) break;
      }
    }

    onStage('等待授权回调');
    const code = await Promise.race([waitForCode(90000), codeFromPage(page, 90000)]);
    onStage('兑换 refresh token');
    const result = await exchangeCodeForRefreshToken(code);
    onStage('提取成功');
    return result;
  } catch (error) {
    await page.screenshot({ path: path.join(recordingsDir, `${account.id}.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}

async function waitForTotpStep(page, onStage) {
  const deadline = Date.now() + 60000;
  let openedOtherWays = false;

  while (Date.now() < deadline) {
    if (isCallback(page)) return null;

    const input = await firstVisible(page, SELECTORS.totpInput, 300);
    if (input) return input;

    const authenticator = await firstVisible(page, SELECTORS.authenticator, 200);
    if (authenticator) {
      onStage('选择身份验证器');
      await authenticator.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const next = await firstVisible(page, SELECTORS.totpInput, 8000);
      if (next) return next;
      continue;
    }

    if (!openedOtherWays) {
      const clicked = await clickFirst(page, SELECTORS.otherWay, 500);
      if (clicked) {
        openedOtherWays = true;
        await page.waitForTimeout(900);
        continue;
      }
    }

    await page.waitForTimeout(500);
  }
  return null;
}

async function waitTotpOutcome(page) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (isCallback(page) || isConsent(page)) return 'ok';

    const input = await firstVisible(page, SELECTORS.totpInput, 250);
    if (input) {
      const errorText = await page
        .locator('text=/代码不正确|验证码不正确|Wrong code|Incorrect code|再试一次/')
        .first()
        .isVisible()
        .catch(() => false);
      if (errorText) return 'retry';
    }
    await page.waitForTimeout(400);
  }
  return (await firstVisible(page, SELECTORS.totpInput, 500)) ? 'retry' : 'ok';
}

async function codeFromPage(page, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.startsWith(CALLBACK_PREFIX)) {
      const code = new URL(url).searchParams.get('code');
      if (code) return code;
    }
    await page.waitForTimeout(250);
  }
  throw new Error('页面未返回授权码');
}
