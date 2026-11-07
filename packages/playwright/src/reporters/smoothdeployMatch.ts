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


export type ManifestStep = {
  id: string;
  action: string;
  title?: string;
  children: ManifestStep[];
};

export type StepLike = {
  title: string;
  category: string;
  apiName?: string;
  channelMethod?: string;
};

const ACTION_API: Record<string, string[]> = {
  navigate: ['Frame.goto'],
  click: ['Frame.click', 'Frame.dblclick', 'Frame.dispatchEvent'],
  fill: ['Frame.fill'],
  press: ['Frame.press'],
  hover: ['Frame.hover'],
  check: ['Frame.check'],
  uncheck: ['Frame.uncheck'],
  select: ['Frame.selectOption'],
  setInputFiles: ['Frame.setInputFiles', 'ElementHandle.setInputFiles'],
  openPage: ['BrowserContext.newPage'],
  closePage: ['Page.close'],
  assertVisible: ['toBeVisible'],
  assertText: ['toContainText', 'toHaveText'],
  assertValue: ['toHaveValue', 'toBeEmpty'],
  assertChecked: ['toBeChecked', 'not.toBeChecked'],
  assertSnapshot: ['toHaveScreenshot', 'toMatchAriaSnapshot'],
};

const FILLER_API_NEVER_SKIPS_AHEAD = new Set(['Frame.dispatchEvent']);

function stepApi(step: StepLike): string | null {
  if (step.category === 'pw:api')
    return step.channelMethod ?? null;
  return normalizeApiName(step.apiName);
}

export function shortApi(step: StepLike): string | null {
  const api = stepApi(step);
  if (!api)
    return null;
  const idx = api.lastIndexOf('.');
  return step.category === 'pw:api' && idx >= 0 ? api.slice(idx + 1) : api;
}

function normalizeApiName(apiName: string | undefined): string | null {
  if (!apiName)
    return null;
  if (apiName.startsWith('expect')) {
    if (apiName.includes('.poll') || apiName.includes('.soft'))
      return null;
    const matcher = apiName.slice('expect'.length).replace(/^\./, '');
    return matcher || null;
  }
  const idx = apiName.lastIndexOf('.');
  return idx >= 0 ? apiName.slice(idx + 1) : apiName;
}

function apiMatches(step: StepLike, expected: ManifestStep): boolean {
  const api = stepApi(step);
  if (!api)
    return false;
  const allowed = ACTION_API[expected.action];
  return !!allowed && allowed.includes(api);
}

function groupMatches(step: StepLike, expected: ManifestStep): boolean {
  if (expected.title !== undefined)
    return step.title === expected.title;
  return expected.action === 'group';
}

function stepMatches(step: StepLike, expected: ManifestStep): boolean {
  if (step.category === 'test.step')
    return groupMatches(step, expected);
  if (step.category === 'pw:api' || step.category === 'expect')
    return apiMatches(step, expected);
  return false;
}

export function matchStep(step: StepLike, siblings: ManifestStep[], cursor: number): number {
  if (cursor < siblings.length && stepMatches(step, siblings[cursor]))
    return cursor;
  const api = stepApi(step);
  const canLookAhead = step.category === 'test.step'
    ? siblings.some(s => s.title !== undefined)
    : !!api && !FILLER_API_NEVER_SKIPS_AHEAD.has(api);
  if (!canLookAhead)
    return -1;
  for (let j = cursor + 1; j < siblings.length; j++) {
    if (stepMatches(step, siblings[j]))
      return j;
  }
  return -1;
}

const INTERNAL_STEP_TITLES = new Set([
  'Before Hooks', 'After Hooks', 'Worker Cleanup',
  'Launch browser', 'Launch persistent context', 'Connect over CDP', 'Close browser',
  'Create context', 'Close context', 'Create page', 'Close page', 'Create CDP session',
]);

export function isToPassWrapper(step: StepLike): boolean {
  return normalizeApiName(step.apiName) === 'toPass';
}

export function isUserStep(step: { title: string, category: string }): boolean {
  if (step.category === 'hook' || step.category === 'fixture' || step.category === 'test.attach')
    return false;
  if (step.title.startsWith('Fixture "'))
    return false;
  return !INTERNAL_STEP_TITLES.has(step.title);
}
