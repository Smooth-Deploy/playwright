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

import { jpegjs } from 'playwright-core/lib/utilsBundle';

import { test, expect } from './playwright-test-fixtures';
import { parseTraceRaw } from '../config/utils';

const files = (dir: string, suffix: string) => fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(f => f.endsWith(suffix)).map(f => path.join(dir, f));

async function lastTraceFrameSize(dir: string) {
  const { events, resources } = await parseTraceRaw(files(dir, 'trace.zip')[0]);
  const frame = events.filter(e => e.type === 'screencast-frame').pop();
  const { width, height } = jpegjs.decode(resources.get(frame.file)!);
  return { width, height };
}

// Counts screencast frames whose device size differs from the viewport: that is the
// Page.captureScreenshot emulation "blip" (https://github.com/invm/playwright/issues/8).
const spec = (browserName: string) => `
  import { test, expect } from '@playwright/test';
  test('steps', async ({ page, context }) => {
    let blips = 0;
    if ('${browserName}' === 'chromium') {
      const cdp = await context.newCDPSession(page);
      cdp.on('Page.screencastFrame', ({ sessionId, metadata }) => {
        if (metadata.deviceWidth !== 1000 || metadata.deviceHeight !== 600)
          blips++;
        cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', maxWidth: 100, maxHeight: 100 });
    }
    await page.setContent('<input id=a><button id=b onclick="this.textContent=\\'done\\'">go</button>');
    await page.locator('#a').fill('name');
    await page.locator('#b').click();
    await expect(page.locator('#b')).toHaveText('done');
    console.log('%%blips=' + blips);
  });
`;

for (const browserName of ['chromium', 'firefox', 'webkit']) {
  for (const mode of ['off', 'plain', 'trace', 'trace+video'] as const) {
    test(`should write result screenshots without blips (${browserName}, ${mode})`, async ({ runInlineTest }, testInfo) => {
      const result = await runInlineTest({
        'playwright.config.ts': `
          export default {
            use: {
              browserName: '${browserName}',
              viewport: { width: 1000, height: 600 },
              trace: '${mode.startsWith('trace') ? 'on' : 'off'}',
              video: '${mode === 'trace+video' ? 'on' : 'off'}',
            },
          };
        `,
        'a.spec.ts': spec(browserName),
      }, { workers: 1 }, mode === 'off' ? {} : { SD_SCREENSHOTS: '1' });
      expect(result.exitCode).toBe(0);
      expect(result.outputLines).toContain('blips=0');

      const dir = testInfo.outputPath('.smoothdeploy-output', 'screenshots');
      if (mode === 'off') {
        expect(fs.existsSync(dir)).toBe(false);
        return;
      }
      expect(files(dir, '-page.png').map(f => fs.readFileSync(f).readUInt32BE(16))).toEqual(Array(3).fill(1000));
      expect(files(dir, '-element.png')).toHaveLength(3);
      if (mode.startsWith('trace'))
        expect(await lastTraceFrameSize(testInfo.outputPath('test-results'))).toEqual({ width: 1000, height: 600 });
    });
  }
}

test('keeps an explicit video size', async ({ runInlineTest }, testInfo) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      export default {
        use: {
          viewport: { width: 1000, height: 600 },
          video: { mode: 'on', size: { width: 400, height: 240 } },
        },
      };
    `,
    'a.spec.ts': `
      import { test } from '@playwright/test';
      test('video', async ({ page }) => {
        await page.setContent('<input id=a>');
        await page.locator('#a').fill('name');
      });
    `,
  }, { workers: 1 }, { SD_SCREENSHOTS: '1' });
  expect(result.exitCode).toBe(0);
  const dir = testInfo.outputPath('.smoothdeploy-output', 'screenshots');
  expect(files(dir, '-page.png').map(f => fs.readFileSync(f).readUInt32BE(16))).toEqual([400]);
});

for (const mode of ['plain', 'trace+video'] as const) {
  test(`takes headed viewport screenshots without blips (${mode})`, async ({ runInlineTest }, testInfo) => {
    const result = await runInlineTest({
      'playwright.config.ts': `
        export default {
          use: {
            browserName: 'chromium',
            headless: false,
            viewport: { width: 1000, height: 600 },
            screenshot: 'on',
            resultScreenshots: ${mode !== 'plain'},
            trace: '${mode === 'plain' ? 'off' : 'on'}',
            video: '${mode === 'plain' ? 'off' : 'on'}',
          },
        };
      `,
      'a.spec.ts': `
        import { test, expect } from '@playwright/test';
        test('steps', async ({ page, context }, testInfo) => {
          let blips = 0;
          const cdp = await context.newCDPSession(page);
          cdp.on('Page.screencastFrame', ({ sessionId, metadata }) => {
            if (metadata.deviceWidth !== 1000 || metadata.deviceHeight !== 600)
              blips++;
            cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
          });
          await cdp.send('Page.startScreencast', { format: 'jpeg', maxWidth: 100, maxHeight: 100 });
          await page.setContent('<input id=a>');
          await page.locator('#a').fill('name');
          await page.screenshot({ path: testInfo.outputPath('manual.png') });
          await page.screenshot({ path: testInfo.outputPath('manual.jpg') });
          await new Promise(f => setTimeout(f, 300));
          console.log('%%blips=' + blips);
        });
      `,
    }, { workers: 1 });
    expect(result.exitCode).toBe(0);
    expect(result.outputLines).toContain('blips=0');
    const dir = testInfo.outputPath('test-results');
    const pngSize = (f: string) => [fs.readFileSync(f).readUInt32BE(16), fs.readFileSync(f).readUInt32BE(20)];
    expect(files(dir, 'manual.png').map(pngSize)).toEqual([[1000, 600]]);
    expect(files(dir, 'test-finished-1.png').map(pngSize)).toEqual([[1000, 600]]);
    const jpg = files(dir, 'manual.jpg');
    expect(jpg).toHaveLength(1);
    const { width, height } = jpegjs.decode(fs.readFileSync(jpg[0]));
    expect([width, height]).toEqual([1000, 600]);
  });
}
