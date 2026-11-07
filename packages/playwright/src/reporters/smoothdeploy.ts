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


import * as fs from 'fs';
import * as path from 'path';
import { isToPassWrapper, isUserStep, matchStep, shortApi } from './smoothdeployMatch';
import type { FullConfig, TestCase, TestResult, TestStep, FullResult } from '../../types/testReporter';
import type { ReporterV2 } from './reporterV2';
import type { ReporterStepFields } from '../common/ipc';
import type { ManifestStep } from './smoothdeployMatch';

type ManifestTest = {
  id: string;
  title: string;
  steps: ManifestStep[];
};

type ManifestSuite = {
  id: string;
  title: string;
  tests: ManifestTest[];
  suites: ManifestSuite[];
};

type ManifestFile = {
  tests: ManifestTest[];
  suites: ManifestSuite[];
};

type InputManifest = {
  version: number;
  files: Record<string, ManifestFile>;
};

type StepData = {
  id?: string;
  action?: string;
  title: string;
  category: string;
  duration: number;
  error: { message: string } | null;
  screenshots: { page: string; element: string } | null;
  skipped?: boolean;
  children: StepData[];
};

type ResolvedTest = {
  manifestTest: ManifestTest;
  projectName: string;
  passthroughRootId?: string;
  passthrough: boolean;
};

type Matched = {
  manifest: ManifestStep;
  output: StepData;
  cursor: number;
};

type ReporterStep = TestStep & ReporterStepFields;

type RetryAttempt = {
  parent: Matched | undefined;
  startCursor: number;
  events: object[];
  outputs: StepData[];
};

const NO_SCREENSHOT_PREFIXES = ['Navigate', 'Go back', 'Go forward', 'Reload', 'Screenshot', 'Wait for', 'Pause', 'Evaluate'];

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '-');

class SmoothDeployReporter implements ReporterV2 {
  private _configDir = '';
  private _manifest: InputManifest | null = null;
  private _resolvedTests = new Map<string, ResolvedTest>();
  private _matched = new WeakMap<TestStep, Matched>();
  private _opaqueFiller = new WeakSet<TestStep>();
  private _retries = new WeakMap<TestStep, RetryAttempt>();
  private _rootCursors = new Map<string, number>();
  private _testSteps = new Map<string, StepData[]>();
  private _projectNames: string[] = [];
  private _stepIdMap = new Map<string, string>();

  version(): 'v2' {
    return 'v2';
  }

  printsToStdio(): boolean {
    return false;
  }

  onConfigure(config: FullConfig) {
    this._configDir = config.configFile ? path.dirname(config.configFile) : config.rootDir;
    this._projectNames = config.projects.map(p => p.name);
    const manifestPath = path.join(this._configDir, '.smoothdeploy-manifest.json');
    if (fs.existsSync(manifestPath))
      this._manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as InputManifest;
  }

  private _emit(event: object, step?: TestStep) {
    const retry = step && this._nearestRetry(step);
    if (retry)
      retry.events.push(event);
    else
      // eslint-disable-next-line no-restricted-properties
      process.stdout.write(`[SMOOTHDEPLOY_EVENT]${JSON.stringify(event)}\n`);
  }

  private _nearestRetry(step: TestStep): RetryAttempt | undefined {
    for (let p = step.parent; p; p = p.parent) {
      const retry = this._retries.get(p);
      if (retry)
        return retry;
    }
    return undefined;
  }

  private _resolveManifestTest(test: TestCase): ResolvedTest {
    const projectName = test.parent.project()?.name ?? '';
    const manifestTest = this._findManifestTest(test);
    if (!manifestTest)
      return { manifestTest: { id: test.id, title: test.title, steps: [] }, projectName, passthrough: true };
    const single = manifestTest.steps.length === 1 ? manifestTest.steps[0] : undefined;
    if (single && single.action === 'script')
      return { manifestTest, projectName, passthrough: true, passthroughRootId: single.id };
    return { manifestTest, projectName, passthrough: false };
  }

  private _findManifestTest(test: TestCase): ManifestTest | null {
    if (!this._manifest)
      return null;
    const titlePath = test.titlePath();
    const relFile = path.relative(this._configDir, test.location.file);
    const fileManifest = this._manifest.files[relFile];
    if (!fileManifest)
      return null;
    const fileIdx = titlePath.indexOf(relFile);
    const describeTitles = fileIdx >= 0 ? titlePath.slice(fileIdx + 1, -1) : [];
    let currentSuites = fileManifest.suites;
    let currentTests = fileManifest.tests;
    for (const desc of describeTitles) {
      const suite = currentSuites.find(s => s.title === desc);
      if (!suite)
        return null;
      currentSuites = suite.suites;
      currentTests = suite.tests;
    }
    return currentTests.find(t => t.title === test.title) ?? null;
  }

  onTestBegin(test: TestCase, result: TestResult) {
    const resolved = this._resolveManifestTest(test);
    this._resolvedTests.set(test.id, resolved);
    this._rootCursors.set(test.id, 0);
    this._testSteps.set(test.id, []);
    this._emit({
      event: 'testBegin',
      testId: resolved.manifestTest.id,
      projectName: resolved.projectName,
      testTitle: test.title,
      timestamp: Date.now(),
    });
    if (resolved.passthroughRootId) {
      this._emit({
        event: 'stepBegin',
        testId: resolved.manifestTest.id,
        projectName: resolved.projectName,
        id: resolved.passthroughRootId,
        action: 'script',
        title: test.title,
        category: 'test.step',
        timestamp: Date.now(),
      });
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const resolved = this._resolvedTests.get(test.id);
    if (!resolved)
      return;
    if (resolved.passthroughRootId) {
      this._emit({
        event: 'stepEnd',
        testId: resolved.manifestTest.id,
        projectName: resolved.projectName,
        id: resolved.passthroughRootId,
        action: 'script',
        title: test.title,
        duration: result.duration,
        error: result.error ? { message: result.error.message } : null,
        timestamp: Date.now(),
      });
    }
    this._emit({
      event: 'testEnd',
      testId: resolved.manifestTest.id,
      projectName: resolved.projectName,
      testTitle: test.title,
      status: result.status,
      duration: result.duration,
      timestamp: Date.now(),
    });
    this._rootCursors.delete(test.id);
  }

  private _nearestMatchedAncestor(step: TestStep): { matched?: Matched, blocked: boolean } {
    for (let p = step.parent; p; p = p.parent) {
      const matched = this._matched.get(p);
      if (matched)
        return { matched, blocked: false };
      if (this._opaqueFiller.has(p))
        return { blocked: true };
    }
    return { blocked: false };
  }

  private _resolveStep(test: TestCase, resolved: ResolvedTest, step: ReporterStep, parent: Matched | undefined): ManifestStep | null {
    const stepLike = { title: step.title, category: step.category, apiName: step._apiName, channelMethod: step._channelMethod };
    if (resolved.passthrough) {
      const index = parent ? parent.cursor : this._rootCursors.get(test.id) ?? 0;
      const prefix = parent ? `${parent.manifest.id}:` : resolved.passthroughRootId ? `${resolved.passthroughRootId}:` : '';
      if (parent)
        parent.cursor = index + 1;
      else
        this._rootCursors.set(test.id, index + 1);
      const action = step.category === 'test.step' ? 'group' : shortApi(stepLike) ?? step.category;
      return { id: `${prefix}${index}`, action, title: step.title, children: [] };
    }
    if (parent && parent.manifest.children.length === 0)
      return null;
    const siblings = parent ? parent.manifest.children : resolved.manifestTest.steps;
    const cursor = parent ? parent.cursor : this._rootCursors.get(test.id) ?? 0;
    let index = matchStep(stepLike, siblings, cursor);
    const retry = this._nearestRetry(step);
    if (index < 0 && retry && retry.parent === parent && cursor > retry.startCursor) {
      index = matchStep(stepLike, siblings.slice(0, cursor), retry.startCursor);
      if (index >= 0)
        this._discardAttempt(test, retry);
    }
    if (index < 0)
      return null;
    if (parent)
      parent.cursor = index + 1;
    else
      this._rootCursors.set(test.id, index + 1);
    return siblings[index];
  }

  private _discardAttempt(test: TestCase, retry: RetryAttempt) {
    const list = retry.parent ? retry.parent.output.children : this._testSteps.get(test.id);
    for (const output of retry.outputs) {
      const i = list ? list.indexOf(output) : -1;
      if (i >= 0)
        list!.splice(i, 1);
    }
    retry.outputs = [];
    retry.events = [];
  }

  onStepBegin(test: TestCase, result: TestResult, step: ReporterStep) {
    if (!isUserStep(step))
      return;
    const resolved = this._resolvedTests.get(test.id);
    if (!resolved)
      return;
    const { matched: parent, blocked } = this._nearestMatchedAncestor(step);
    const manifestStep = blocked ? null : this._resolveStep(test, resolved, step, parent);
    if (!manifestStep) {
      if (blocked || !isToPassWrapper({ title: step.title, category: step.category, apiName: step._apiName }))
        this._opaqueFiller.add(step);
      else
        this._retries.set(step, { parent, startCursor: parent ? parent.cursor : this._rootCursors.get(test.id) ?? 0, events: [], outputs: [] });
      return;
    }
    const output: StepData = {
      id: manifestStep.id,
      action: manifestStep.action,
      title: step.title,
      category: step.category,
      duration: 0,
      error: null,
      screenshots: null,
      children: [],
    };
    this._matched.set(step, { manifest: manifestStep, output, cursor: 0 });
    const retry = this._nearestRetry(step);
    if (retry && retry.parent === parent)
      retry.outputs.push(output);
    if (parent)
      parent.output.children.push(output);
    else
      this._testSteps.get(test.id)?.push(output);
    this._emit({
      event: 'stepBegin',
      testId: resolved.manifestTest.id,
      projectName: resolved.projectName,
      id: manifestStep.id,
      action: manifestStep.action,
      title: step.title,
      category: step.category,
      timestamp: Date.now(),
    }, step);
  }

  private _screenshotsFor(test: TestCase, step: ReporterStep) {
    const hasScreenshot = (step.category === 'pw:api' || step.category === 'expect') && !NO_SCREENSHOT_PREFIXES.some(prefix => step.title.startsWith(prefix));
    if (!hasScreenshot)
      return null;
    const safeStepId = safeId(step._stepId ?? step.title);
    return {
      safeStepId,
      paths: {
        page: `.smoothdeploy-output/screenshots/${safeId(test.id)}/${safeStepId}-page.png`,
        element: `.smoothdeploy-output/screenshots/${safeId(test.id)}/${safeStepId}-element.png`,
      },
    };
  }

  onStepEnd(test: TestCase, result: TestResult, step: ReporterStep) {
    if (!isUserStep(step))
      return;
    const resolved = this._resolvedTests.get(test.id);
    if (!resolved)
      return;
    const retry = this._retries.get(step);
    if (retry) {
      this._retries.delete(step);
      for (const event of retry.events)
        this._emit(event, step);
      return;
    }
    const matched = this._matched.get(step);
    const screenshots = this._screenshotsFor(test, step);
    if (!matched) {
      const leaf = this._nearestMatchedAncestor(step).matched;
      if (screenshots && leaf && leaf.manifest.children.length === 0 && !leaf.output.screenshots) {
        this._stepIdMap.set(screenshots.safeStepId, safeId(leaf.manifest.id));
        leaf.output.screenshots = screenshots.paths;
      }
      return;
    }
    if (screenshots) {
      this._stepIdMap.set(screenshots.safeStepId, safeId(matched.manifest.id));
      matched.output.screenshots = screenshots.paths;
    }
    matched.output.duration = step.duration;
    const skipped = step.annotations.some(a => a.type === 'skip');
    if (skipped)
      matched.output.skipped = true;
    const hasDescendantError = (steps: StepData[]): boolean =>
      steps.some(c => c.error !== null || hasDescendantError(c.children));
    matched.output.error = step.error && !hasDescendantError(matched.output.children) ? { message: step.error.message ?? '' } : null;
    this._emit({
      event: 'stepEnd',
      testId: resolved.manifestTest.id,
      projectName: resolved.projectName,
      id: matched.manifest.id,
      action: matched.manifest.action,
      title: step.title,
      duration: step.duration,
      error: step.error ? { message: step.error.message } : null,
      skipped,
      timestamp: Date.now(),
    }, step);
  }

  onEnd(result: FullResult) {
    const outputDir = path.join(process.cwd(), '.smoothdeploy-output');
    const screenshotsDir = path.join(outputDir, 'screenshots');
    const screenshotDirs = this._screenshotDirs();
    for (const testId of screenshotDirs.keys()) {
      const testDir = path.join(screenshotsDir, safeId(testId));
      if (!fs.existsSync(testDir))
        continue;
      for (const [safePwStepId, safeManifestStepId] of this._stepIdMap) {
        for (const suffix of ['-page.png', '-element.png']) {
          const src = path.join(testDir, `${safePwStepId}${suffix}`);
          if (fs.existsSync(src))
            fs.renameSync(src, path.join(testDir, `${safeManifestStepId}${suffix}`));
        }
      }
    }
    const byDepth = [...screenshotDirs].sort(([, a], [, b]) => a.split('/').length - b.split('/').length);
    for (const [testId, dir] of byDepth) {
      const src = path.join(screenshotsDir, safeId(testId));
      const dst = path.join(screenshotsDir, dir);
      if (src !== dst && fs.existsSync(src)) {
        if (fs.existsSync(dst))
          fs.rmSync(dst, { recursive: true });
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
      }
    }

    const remapScreenshotPaths = (steps: StepData[], testId: string, dir: string) => {
      for (const step of steps) {
        if (step.screenshots) {
          step.screenshots.page = this._remapPath(step.screenshots.page, testId, dir);
          step.screenshots.element = this._remapPath(step.screenshots.element, testId, dir);
          if (!fs.existsSync(path.join(process.cwd(), step.screenshots.page)))
            step.screenshots = null;
        }
        remapScreenshotPaths(step.children, testId, dir);
      }
    };

    const manifest: Record<string, { projectName: string; steps: StepData[]; failureScreenshot: string | null }[]> = {};
    for (const [testId, steps] of this._testSteps) {
      const resolved = this._resolvedTests.get(testId);
      if (!resolved)
        continue;
      const dir = screenshotDirs.get(testId)!;
      remapScreenshotPaths(steps, testId, dir);
      const failureScreenshot = fs.existsSync(path.join(screenshotsDir, dir, 'failure.png'))
        ? `.smoothdeploy-output/screenshots/${dir}/failure.png`
        : null;
      const key = resolved.manifestTest.id;
      if (!manifest[key])
        manifest[key] = [];
      manifest[key].push({ projectName: resolved.projectName, steps, failureScreenshot });
    }

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    this._emit({ event: 'runEnd', status: result.status, timestamp: Date.now() });
  }

  // The first configured project keeps screenshots/<testId>/, which the console builds remote-run URLs from; other projects get a subfolder.
  private _screenshotDirs(): Map<string, string> {
    const primary = new Map<string, { testId: string, rank: number }>();
    for (const [testId, resolved] of this._resolvedTests) {
      const rank = this._projectNames.indexOf(resolved.projectName);
      const current = primary.get(resolved.manifestTest.id);
      if (!current || rank < current.rank)
        primary.set(resolved.manifestTest.id, { testId, rank });
    }
    const dirs = new Map<string, string>();
    for (const [testId, resolved] of this._resolvedTests) {
      const base = safeId(resolved.manifestTest.id);
      dirs.set(testId, primary.get(resolved.manifestTest.id)!.testId === testId ? base : `${base}/${safeId(resolved.projectName) || 'default'}`);
    }
    return dirs;
  }

  private _remapPath(screenshotPath: string, testId: string, dir: string): string {
    let result = screenshotPath.replace(`/${safeId(testId)}/`, `/${dir}/`);
    for (const [safePwStepId, safeManifestStepId] of this._stepIdMap)
      result = result.replace(`/${safePwStepId}-`, `/${safeManifestStepId}-`);
    return result;
  }
}

export default SmoothDeployReporter;
