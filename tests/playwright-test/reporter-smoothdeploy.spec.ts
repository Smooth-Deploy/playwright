/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


import fs from 'fs';
import path from 'path';
import { test, expect } from './playwright-test-fixtures';

type Event = { event: string, id?: string, action?: string, title?: string, category?: string, testId?: string, duration?: number, error?: { message?: string } | null, skipped?: boolean, projectName?: string };

function events(output: string): Event[] {
  const marker = '[SMOOTHDEPLOY_EVENT]';
  return output.split('\n')
      .filter(line => line.includes(marker))
      .map(line => JSON.parse(line.slice(line.indexOf(marker) + marker.length)));
}

const step = (id: string, action: string, extra: object = {}, children: object[] = []) => ({ id, action, children, ...extra });

const manifest = {
  version: 1,
  files: {
    'a.spec.ts': {
      suites: [],
      tests: [{
        id: 'test-1',
        title: 'authored',
        steps: [
          step('s-nav', 'navigate'),
          step('s-login', 'group', { title: 'Login' }, [
            step('s-login:s-fill', 'fill'),
            step('s-login:s-wait', 'wait', { title: 'Settle' }),
            step('s-login:s-press', 'press'),
          ]),
          step('s-cond', 'group', { title: 'Close modal - if visible' }, [
            step('s-cond:s-click', 'click'),
          ]),
          step('s-cond-leaf', 'click', { title: 'Click banner - if visible' }),
          step('s-assert', 'assertVisible'),
          step('s-retry', 'group', { title: 'Retry group' }, [
            step('s-retry:s-click', 'click'),
          ]),
        ],
      }],
    },
  },
};

const authoredSpec = `
  import { test, expect } from '@playwright/test';
  const gate = (probe) => expect.poll(probe, { timeout: 1000 }).toBe(true).then(() => true, () => false);
  test('authored', async ({ page }) => {
    await page.goto('about:blank');
    await page.setContent('<input id="a"><button id="b">go</button><div id="c">c</div><script>setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<button id=late>l</button>"), 700)</script>');
    await test.step('Login', async () => {
      if (await gate(() => page.evaluate(() => true))) {
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(200);
      await page.locator('#a').fill('name');
      await page.locator('#a').blur();
      await page.waitForTimeout(200);
      await test.step('Settle', async () => {
        await page.waitForTimeout(500);
      }, {});
      await page.waitForTimeout(200);
      await page.locator('#a').press('Enter');
    }, {});
    await test.step('Close modal - if visible', async (step) => {
      step.skip(!(await page.locator('#nope').isVisible({ timeout: 100 })));
      await page.locator('#b').click();
    }, {});
    await test.step('Click banner - if visible', async (step) => {
      step.skip(!(await page.locator('#nope').isVisible({ timeout: 100 })));
      await page.locator('#b').click();
    }, {});
    await page.waitForTimeout(200);
    await expect(page.locator('#c')).toBeVisible();
    await test.step('Retry group', async () => {
      await expect(async () => {
        await page.waitForTimeout(200);
        await page.locator('#late').click({ timeout: 300 });
      }).toPass({ timeout: 5000 });
    }, {});
  });
`;

test('maps authored steps by expected action and skips filler', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    '.smoothdeploy-manifest.json': JSON.stringify(manifest),
    'playwright.config.ts': `module.exports = { reporter: 'smoothdeploy' };`,
    'a.spec.ts': authoredSpec,
  });
  expect(result.exitCode).toBe(0);
  const all = events(result.output);
  const begins = all.filter(e => e.event === 'stepBegin').map(e => e.id);
  expect(begins).toEqual([
    's-nav',
    's-login',
    's-login:s-fill',
    's-login:s-wait',
    's-login:s-press',
    's-cond',
    's-cond-leaf',
    's-assert',
    's-retry',
    's-retry:s-click',
  ]);
  const skipped = all.filter(e => e.event === 'stepEnd' && e.skipped).map(e => e.id);
  expect(skipped).toEqual(['s-cond', 's-cond-leaf']);
  expect(all.filter(e => e.event === 'stepEnd' && !e.skipped).every(e => e.skipped === false)).toBe(true);
  const ends = all.filter(e => e.event === 'stepEnd').map(e => e.id);
  expect([...ends].sort()).toEqual([...begins].sort());
  expect(all[0].event).toBe('testBegin');
  expect(all.slice(-2).map(e => e.event)).toEqual(['testEnd', 'runEnd']);
  const waitEnd = all.find(e => e.event === 'stepEnd' && e.id === 's-login:s-wait')!;
  expect(waitEnd.duration!).toBeGreaterThanOrEqual(450);
  const retryEnds = all.filter(e => e.event === 'stepEnd' && e.id === 's-retry:s-click');
  expect(retryEnds).toHaveLength(1);
  expect(retryEnds[0].error).toBeNull();
});

test('maps authored steps when page calls go through a user proxy', async ({ runInlineTest }) => {
  const proxied = authoredSpec.replace(`import { test, expect } from '@playwright/test';`, `
    import { test as base, expect } from '@playwright/test';
    const wrap = target => new Proxy(target, {
      get(obj, prop) {
        const value = Reflect.get(obj, prop, obj);
        if (typeof value !== 'function') return value;
        return (...args) => {
          const result = value.apply(obj, args);
          return result && typeof result === 'object' && typeof result.click === 'function' ? wrap(result) : result;
        };
      },
    });
    const test = base.extend({ page: async ({ page }, use) => { await use(wrap(page)); } });
  `);
  const result = await runInlineTest({
    '.smoothdeploy-manifest.json': JSON.stringify(manifest),
    'playwright.config.ts': `module.exports = { reporter: 'smoothdeploy' };`,
    'a.spec.ts': proxied,
  });
  expect(result.exitCode).toBe(0);
  const begins = events(result.output).filter(e => e.event === 'stepBegin').map(e => e.id);
  expect(begins).toEqual([
    's-nav',
    's-login',
    's-login:s-fill',
    's-login:s-wait',
    's-login:s-press',
    's-cond',
    's-cond-leaf',
    's-assert',
    's-retry',
    's-retry:s-click',
  ]);
});

test('passes plain playwright steps through when there is no manifest', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `module.exports = { reporter: 'smoothdeploy' };`,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('plain', async ({ page }) => {
        await page.setContent('<div id="c">c</div>');
        await test.step('outer', async () => {
          await expect(page.locator('#c')).toBeVisible();
          await test.step('inner', async () => {
            await page.locator('#c').click();
          });
        });
      });
    `,
  });
  expect(result.exitCode).toBe(0);
  const begins = events(result.output).filter(e => e.event === 'stepBegin');
  expect(begins.map(e => [e.id, e.action, e.title])).toEqual([
    ['0', 'setContent', 'Set content'],
    ['1', 'group', 'outer'],
    ['1:0', 'toBeVisible', expect.stringContaining('Expect "toBeVisible"')],
    ['1:1', 'group', 'inner'],
    ['1:1:0', 'click', expect.stringContaining('Click')],
  ]);
});

test('prefixes passthrough ids with the script step id', async ({ runInlineTest }) => {
  const scriptManifest = {
    version: 1,
    files: { 'a.spec.ts': { suites: [], tests: [{ id: 'test-1', title: 'script test', steps: [step('script-1', 'script')] }] } },
  };
  const result = await runInlineTest({
    '.smoothdeploy-manifest.json': JSON.stringify(scriptManifest),
    'playwright.config.ts': `module.exports = { reporter: 'smoothdeploy' };`,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('script test', async ({ page }) => {
        await page.setContent('<div id="c">c</div>');
        await test.step('outer', async () => {
          await page.locator('#c').click();
        });
      });
    `,
  });
  expect(result.exitCode).toBe(0);
  const all = events(result.output);
  expect(all.filter(e => e.event === 'stepBegin').map(e => e.id)).toEqual(['script-1', 'script-1:0', 'script-1:1', 'script-1:1:0']);
  expect(all.filter(e => e.event === 'stepEnd').map(e => e.id)).toEqual(['script-1:0', 'script-1:1:0', 'script-1:1', 'script-1']);
  expect(all.every(e => !e.testId || e.testId === 'test-1')).toBe(true);
});

test('identifies results by project name', async ({ runInlineTest }, testInfo) => {
  const projectManifest = {
    version: 1,
    files: { 'a.spec.ts': { suites: [], tests: [{ id: 'test-1', title: 'login', steps: [step('s-nav', 'navigate')] }] } },
  };
  const result = await runInlineTest({
    '.smoothdeploy-manifest.json': JSON.stringify(projectManifest),
    'playwright.config.ts': `module.exports = { reporter: 'smoothdeploy', projects: [{ name: 'alpha' }, { name: 'beta' }] };`,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('login', async ({ page }) => {
        await page.goto('about:blank');
      });
    `,
  }, { workers: 1 });
  expect(result.exitCode).toBe(0);
  const testEvents = events(result.output).filter(e => e.event !== 'runEnd');
  expect(testEvents.map(e => [e.event, e.testId, e.projectName])).toEqual([
    ['testBegin', 'test-1', 'alpha'],
    ['stepBegin', 'test-1', 'alpha'],
    ['stepEnd', 'test-1', 'alpha'],
    ['testEnd', 'test-1', 'alpha'],
    ['testBegin', 'test-1', 'beta'],
    ['stepBegin', 'test-1', 'beta'],
    ['stepEnd', 'test-1', 'beta'],
    ['testEnd', 'test-1', 'beta'],
  ]);
  expect(result.output).not.toContain('paramIndex');
  const output = JSON.parse(fs.readFileSync(testInfo.outputPath('.smoothdeploy-output', 'manifest.json'), 'utf-8'));
  expect(output['test-1'].map((r: any) => [r.projectName, r.steps.map((s: any) => s.id), 'paramIndex' in r])).toEqual([
    ['alpha', ['s-nav'], false],
    ['beta', ['s-nav'], false],
  ]);
});

test('links expect screenshots and drops paths with no file', async ({ runInlineTest }, testInfo) => {
  const screenshotManifest = {
    version: 1,
    files: { 'a.spec.ts': { suites: [], tests: [{ id: 'test-1', title: 'shots', steps: [
      step('s-fill', 'fill'),
      step('s-assert', 'assertVisible'),
      step('s-snap', 'assertSnapshot'),
    ] }] } },
  };
  const result = await runInlineTest({
    '.smoothdeploy-manifest.json': JSON.stringify(screenshotManifest),
    'playwright.config.ts': `module.exports = { reporter: 'smoothdeploy' };`,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('shots', async ({ page }) => {
        await page.setContent('<input id="a"><div id="c">c</div>');
        await page.locator('#a').fill('name');
        await expect(page.locator('#c')).toBeVisible();
        await expect(page).toHaveScreenshot();
      });
    `,
  }, { 'workers': 1, 'update-snapshots': 'all' }, { SD_SCREENSHOTS: '1' });
  expect(result.exitCode).toBe(0);
  const outputDir = testInfo.outputPath('.smoothdeploy-output');
  const output = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf-8'));
  const steps = output['test-1'][0].steps;
  expect(steps.map((s: any) => [s.id, s.screenshots?.page.split('/').pop() ?? null])).toEqual([
    ['s-fill', 's-fill-page.png'],
    ['s-assert', 's-assert-page.png'],
    ['s-snap', null],
  ]);
  const linked = steps.flatMap((s: any) => s.screenshots ? [s.screenshots.page, s.screenshots.element] : []).map((p: string) => path.basename(p));
  const onDisk = fs.readdirSync(path.join(outputDir, 'screenshots', 'test-1'));
  expect(onDisk.sort()).toEqual(linked.sort());
});

test('keeps screenshots of every project', async ({ runInlineTest }, testInfo) => {
  const screenshotManifest = {
    version: 1,
    files: { 'a.spec.ts': { suites: [], tests: [{ id: 'test-1', title: 'shots', steps: [step('s-fill', 'fill')] }] } },
  };
  const result = await runInlineTest({
    '.smoothdeploy-manifest.json': JSON.stringify(screenshotManifest),
    'playwright.config.ts': `module.exports = { reporter: 'smoothdeploy', projects: [{ name: 'alpha' }, { name: 'beta [2]' }] };`,
    'a.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('shots', async ({ page }, testInfo) => {
        await page.setContent('<input id="a">');
        await page.locator('#a').fill(testInfo.project.name);
        expect(testInfo.project.name).toBe('alpha');
      });
    `,
  }, { 'workers': 1 }, { SD_SCREENSHOTS: '1' });
  expect(result.exitCode).toBe(1);
  const outputDir = testInfo.outputPath('.smoothdeploy-output');
  const output = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf-8'));
  const byProject = Object.fromEntries(output['test-1'].map((r: any) => [r.projectName, r]));
  expect(byProject['alpha'].steps[0].screenshots.page).toBe('.smoothdeploy-output/screenshots/test-1/s-fill-page.png');
  expect(byProject['alpha'].failureScreenshot).toBe(null);
  expect(byProject['beta [2]'].steps[0].screenshots.page).toBe('.smoothdeploy-output/screenshots/test-1/beta--2-/s-fill-page.png');
  expect(byProject['beta [2]'].failureScreenshot).toBe('.smoothdeploy-output/screenshots/test-1/beta--2-/failure.png');
  const read = (p: string) => fs.readFileSync(testInfo.outputPath(p));
  expect(read(byProject['alpha'].steps[0].screenshots.page).equals(read(byProject['beta [2]'].steps[0].screenshots.page))).toBe(false);
  expect(fs.existsSync(testInfo.outputPath(byProject['beta [2]'].failureScreenshot))).toBe(true);
});
