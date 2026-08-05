import { expect, test } from '@playwright/test';

test('demo · multiple before/after scenario diff cases', async ({ page }) => {
  const beforeControl = await test.step('before: control tower state', async () => {
    await renderState(page, 'Control Tower', 'completed 12 · silver 4', 'before-control-tower-state');
    const state = {
      collector: 'collector_foreign_fs',
      completedCount: 12,
      silverHours: 4,
      breakdown: [
        { verdict: 'good', count: 8 },
        { verdict: 'bad', count: 2 },
        { verdict: 'uncertain', count: 2 }
      ]
    };
    await attachJson('before-control-tower-state', state);
    return state;
  });

  const beforeQueue = await test.step('before: curation queue state', async () => {
    await renderState(page, 'Curation Queue', 'pending 1 · completed 12', 'before-curation-queue-state');
    const state = { pending: 1, completed: beforeControl.completedCount, selectedRawDataId: 'raw-demo-1' };
    await attachJson('before-curation-queue-state', state);
    return state;
  });

  const beforeLeaderboard = await test.step('before: leaderboard state', async () => {
    await renderState(page, 'Leaderboard', 'Foreign Collector FS · 14400', 'before-leaderboard-state');
    const state = { rank: 3, name: 'Foreign Collector FS', totalScore: 14_400 };
    await attachJson('before-leaderboard-state', state);
    return state;
  });

  await test.step('when: curator approves as good', async () => {
    await renderState(page, 'Curator', 'grade good · verdict appropriate');
  });

  const afterControl = await test.step('after: control tower state', async () => {
    await renderState(page, 'Control Tower', 'completed 13 · silver 5', 'after-control-tower-state');
    const state = {
      ...beforeControl,
      completedCount: beforeControl.completedCount + 1,
      silverHours: beforeControl.silverHours + 1,
      breakdown: [
        { verdict: 'good', count: 9 },
        { verdict: 'bad', count: 2 },
        { verdict: 'uncertain', count: 2 }
      ]
    };
    await attachJson('after-control-tower-state', state);
    return state;
  });

  await test.step('after: curation queue state', async () => {
    await renderState(page, 'Curation Queue', 'pending 0 · completed 13', 'after-curation-queue-state');
    await attachJson('after-curation-queue-state', {
      ...beforeQueue,
      pending: 0,
      completed: afterControl.completedCount
    });
  });

  const afterLeaderboard = await test.step('after: leaderboard state', async () => {
    await renderState(page, 'Leaderboard', 'Foreign Collector FS · 18000', 'after-leaderboard-state');
    const state = {
      ...beforeLeaderboard,
      rank: 2,
      totalScore: beforeLeaderboard.totalScore + 3_600
    };
    await attachJson('after-leaderboard-state', state);
    return state;
  });

  await attachJson('collector-kpi-delta', {
    completedCount: afterControl.completedCount - beforeControl.completedCount,
    silverHours: afterControl.silverHours - beforeControl.silverHours,
    totalScore: afterLeaderboard.totalScore - beforeLeaderboard.totalScore
  });

  expect(afterControl.silverHours).toBe(beforeControl.silverHours + 1);
  expect(afterLeaderboard.totalScore).toBe(beforeLeaderboard.totalScore + 3_600);
});

async function renderState(page: import('@playwright/test').Page, title: string, value: string, visualName?: string) {
  await page.setContent(`
    <main style="font-family: system-ui; padding: 32px;">
      <h1>${title}</h1>
      <section style="border: 1px solid #ccc; padding: 16px; width: 360px;">
        <strong>${value}</strong>
      </section>
    </main>
  `);
  await page.locator('main').waitFor();
  if (visualName) {
    await test.info().attach(visualName, {
      body: await page.screenshot(),
      contentType: 'image/png'
    });
  }
}

async function attachJson(name: string, data: unknown) {
  await test.info().attach(name, {
    body: JSON.stringify(data, null, 2),
    contentType: 'application/json'
  });
}
