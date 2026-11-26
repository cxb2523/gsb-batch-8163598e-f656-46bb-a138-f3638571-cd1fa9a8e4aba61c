import { expect, test, type Page } from '@playwright/test';

async function preparePage(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.addInitScript(() => {
    const audioWindow = window as Window & {
      __superBlocksAudioPlays?: string[];
    };
    audioWindow.__superBlocksAudioPlays = [];
    HTMLMediaElement.prototype.play = function play() {
      audioWindow.__superBlocksAudioPlays?.push(
        new URL(this.src, window.location.href).pathname
      );
      return Promise.resolve();
    };

    if (window.sessionStorage.getItem('block-blast-e2e-ready')) {
      return;
    }
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('block-blast-')) {
        window.localStorage.removeItem(key);
      }
    }
    window.localStorage.setItem('block-blast-language', 'en');
    window.localStorage.setItem('block-blast-score-version', '3');
    window.sessionStorage.removeItem('block-blast-active-game');
    window.sessionStorage.setItem('block-blast-e2e-ready', 'true');
  });

  return errors;
}

async function openHome(page: Page) {
  const errors = await preparePage(page);
  await page.goto('/');
  await expect(page.getByTestId('block-game')).toHaveAttribute(
    'data-ready',
    'true'
  );
  return errors;
}

async function placePiece(
  page: Page,
  pieceIndex: number,
  row: number,
  column: number
) {
  await page.getByTestId(`game-piece-${pieceIndex}`).click();
  await page.getByTestId(`board-cell-${row}-${column}`).click();
}

type StoredSession = {
  board: Array<Array<string | null>>;
  challengeComplete: boolean;
  combo: number;
  dailyDate: string | null;
  elapsedSeconds: number;
  gameOver: boolean;
  generation: number;
  mode: 'classic' | 'daily';
  movesWithoutClear: number;
  pieces: Array<{
    cells: number[][];
    color: string;
    id: string;
    key: string;
  } | null>;
  score: number;
  seed: number;
  version: 4;
};

/**
 * Builds a version-4 session with an empty board and `pieceCount` single-cell
 * pieces seeded over an all-empty board. Used to deterministically place
 * pieces without depending on the random daily layout.
 */
function buildSeededSession(
  mode: 'classic' | 'daily',
  dailyDate: string | null,
  score: number,
  pieceCount: number
): StoredSession {
  return {
    board: Array.from({ length: 8 }, () =>
      Array.from({ length: 8 }, () => null)
    ),
    challengeComplete: false,
    combo: 0,
    dailyDate,
    elapsedSeconds: 0,
    gameOver: false,
    generation: 1,
    mode,
    movesWithoutClear: 0,
    pieces: [0, 1, 2].map((index) =>
      index < pieceCount
        ? {
            cells: [[0, 0]],
            color: 'red',
            id: `seed-single-${index}`,
            key: 'single',
          }
        : null
    ),
    score,
    seed: 1,
    version: 4,
  };
}

async function seedActiveGame(page: Page, session: StoredSession) {
  await page.evaluate((stored) => {
    sessionStorage.setItem('block-blast-active-game', JSON.stringify(stored));
  }, session);
}

test.describe('Super Blocks', () => {
  test('opens directly on the game menu', async ({ page }) => {
    const errors = await openHome(page);

    await expect(page).toHaveTitle('Super Blocks');
    await expect(page.getByRole('img', { name: 'Super Blocks' })).toBeVisible();
    await expect(page.getByTestId('start-classic')).toBeVisible();
    await expect(page.getByTestId('start-daily')).toBeVisible();
    await expect(page.getByTestId('home-ranking')).toContainText(
      'View your best score for each mode.'
    );
    await expect(page.getByTestId('home-settings')).toBeVisible();
    await expect(page.getByTestId('home-how-to-play')).toBeVisible();
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      '/og.png'
    );
    await expect(
      page.locator('link[rel="icon"][sizes="32x32"]')
    ).toHaveAttribute('href', '/favicon-32x32.png');
    expect(errors).toEqual([]);
  });

  test('dragged piece follows the pointer and can be dropped', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();

    const piece = page.getByTestId('game-piece-0');
    const shape = piece.locator('.piece-shape');
    const target = page.getByTestId('board-cell-3-3');
    const pieceBox = await piece.boundingBox();
    const targetBox = await target.boundingBox();

    expect(pieceBox).not.toBeNull();
    expect(targetBox).not.toBeNull();
    if (!pieceBox || !targetBox) return;

    const pointerStart = {
      x: pieceBox.x + pieceBox.width / 2,
      y: pieceBox.y + pieceBox.height / 2,
    };
    const pointerEnd = {
      x: targetBox.x + targetBox.width / 2,
      y: targetBox.y + targetBox.height / 2,
    };

    await page.mouse.move(pointerStart.x, pointerStart.y);
    await page.mouse.down();
    await page.mouse.move(pointerEnd.x, pointerEnd.y, { steps: 12 });

    const draggedShapeBox = await shape.boundingBox();
    expect(draggedShapeBox).not.toBeNull();
    if (!draggedShapeBox) return;

    const draggedShapeCenter = {
      x: draggedShapeBox.x + draggedShapeBox.width / 2,
      y: draggedShapeBox.y + draggedShapeBox.height / 2,
    };
    expect(
      Math.hypot(
        pointerEnd.x - draggedShapeCenter.x,
        pointerEnd.y - draggedShapeCenter.y
      )
    ).toBeLessThan(12);
    await expect(page.locator('.is-preview-valid')).toHaveCount(3);

    await page.mouse.up();
    await expect(page.locator('.board-cell.is-occupied')).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test('plays a deterministic classic round and saves the score', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();
    await expect(page).toHaveURL(/\/play\/classic$/);
    await expect(page.locator('[data-testid^="game-piece-"]')).toHaveCount(3);
    await expect(page.locator('[data-testid^="board-cell-"]')).toHaveCount(64);

    await placePiece(page, 0, 0, 0);
    await expect(page.getByTestId('game-score')).toHaveText('3');
    await placePiece(page, 1, 0, 3);
    await expect(page.getByTestId('game-score')).toHaveText('6');
    await placePiece(page, 2, 0, 6);
    await expect(page.getByTestId('clear-effect')).toHaveAttribute(
      'data-line-count',
      '1'
    );
    await expect(page.getByTestId('game-score')).toHaveText('18');
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('block-blast-best-score'))
      )
      .toBe('18');
    expect(errors).toEqual([]);
  });

  test('restores an active game after reload', async ({ page }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();
    await placePiece(page, 0, 0, 0);
    await expect(page.getByTestId('game-score')).toHaveText('3');

    await page.reload();
    await expect(page).toHaveURL(/\/play\/classic$/);
    await expect(page.getByTestId('game-score')).toHaveText('3');
    await expect(page.locator('.board-cell.is-occupied')).toHaveCount(3);

    await page.goto('/');
    await expect(page).toHaveURL(/\/play\/classic$/);
    expect(errors).toEqual([]);
  });

  test('returns from settings through browser history without source params', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('start-classic').click();
    await placePiece(page, 0, 0, 0);
    await page.getByRole('link', { name: 'Settings' }).click();

    await expect(page).toHaveURL(/\/settings$/);
    await expect(page).not.toHaveURL(/[?&]from=/);
    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page).toHaveURL(/\/play\/classic$/);
    await expect(page.getByTestId('game-score')).toHaveText('3');
    expect(errors).toEqual([]);
  });

  test('omits descriptive text below the how-to-play and settings titles', async ({
    page,
  }) => {
    const errors = await openHome(page);
    await page.getByTestId('home-how-to-play').click();
    await expect(page).toHaveURL(/\/how-to-play$/);
    await expect(page.locator('.game-inner-intro')).toHaveCount(0);

    await page.goto('/');
    await page.getByTestId('home-settings').click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator('.game-inner-intro')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('persists language and independent preferences', async ({ page }) => {
    const errors = await openHome(page);
    await page.getByTestId('home-settings').click();
    await expect(page).toHaveURL(/\/settings$/);

    await page.getByRole('button', { name: /中文/ }).click();
    await expect(page.getByRole('heading', { name: '游戏设置' })).toBeVisible();
    await page.getByRole('button', { name: /背景音乐/ }).click();
    await page.getByRole('button', { name: /音效/ }).click();
    await page.getByRole('button', { name: /减少动态效果/ }).click();

    await page.reload();
    await expect(page.getByRole('heading', { name: '游戏设置' })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('block-blast-language'))
      )
      .toBe('zh');
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('block-blast-music'))
      )
      .toBe('false');
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('block-blast-sound'))
      )
      .toBe('false');
    await expect(page.getByTestId('game-settings-page')).toHaveClass(
      /reduce-game-motion/
    );
    expect(errors).toEqual([]);
  });

  test('shows an overall and per-mode best score summary', async ({ page }) => {
    const errors = await openHome(page);
    await page.evaluate(() => {
      localStorage.setItem('block-blast-best-score', '321');
      localStorage.setItem(
        'block-blast-score-history',
        JSON.stringify([
          { id: 'classic-321', mode: 'classic', score: 321 },
          { id: 'daily-210', mode: 'daily', score: 210 },
        ])
      );
    });
    await page.getByTestId('home-ranking').click();

    await expect(page).toHaveURL(/\/ranking$/);
    await expect(page.locator('.ranking-best-card strong')).toHaveText('321');
    await expect(
      page.locator('.mode-best-card').nth(0).locator('span')
    ).toHaveText('Classic');
    await expect(
      page.locator('.mode-best-card').nth(0).locator('strong')
    ).toHaveText('321');
    await expect(
      page.locator('.mode-best-card').nth(1).locator('span')
    ).toHaveText('Daily Challenge');
    await expect(
      page.locator('.mode-best-card').nth(1).locator('strong')
    ).toHaveText('210');
    await expect(page.locator('.standalone-score-list')).toHaveCount(0);
    await expect(page.locator('.game-inner-intro')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('serves audio assets and redirects invalid modes', async ({ page }) => {
    const errors = await openHome(page);
    for (const asset of [
      '/game/audio/gameplay-music.ogg',
      '/game/audio/block-place.mp3',
      '/game/audio/game-over.ogg',
    ]) {
      const response = await page.request.get(asset);
      expect(response.ok()).toBe(true);
    }

    await page.goto('/play/not-a-mode');
    await expect(page).toHaveURL('/');
    await expect(page.getByTestId('start-classic')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('binds the daily challenge to the current local day across midnight', async ({
    page,
  }) => {
    // Pin the browser clock so the first local date key is deterministic.
    await page.clock.setFixedTime(new Date(2026, 6, 17, 10, 0, 0));
    const errors = await openHome(page);

    // Load the app once (openHome clears storage on first load), then seed a
    // daily session dated to the pinned day and open the daily route.
    await seedActiveGame(page, buildSeededSession('daily', '2026-07-17', 0, 2));
    await page.goto('/play/daily');
    await expect(page).toHaveURL(/\/play\/daily$/);
    await expect(page.getByTestId('game-score')).toHaveText('0');

    // A placement now persists a session bound to today's local date.
    await placePiece(page, 0, 0, 0);
    await expect(page.getByTestId('game-score')).toHaveText('1');
    await expect
      .poll(() =>
        page.evaluate(
          (key) => JSON.parse(sessionStorage.getItem(key) ?? 'null')?.dailyDate,
          'block-blast-active-game'
        )
      )
      .toBe('2026-07-17');

    // Cross local midnight while the page stays open, then keep playing so a
    // fresh session write is attempted for the already-expired daily run.
    await page.clock.setFixedTime(new Date(2026, 6, 18, 0, 30, 0));
    await placePiece(page, 1, 0, 1);
    await expect(page.getByTestId('game-score')).toHaveText('2');
    await expect
      .poll(() =>
        page.evaluate(
          (key) => sessionStorage.getItem(key),
          'block-blast-active-game'
        )
      )
      .toBeNull();

    // Re-entering the daily mode must start a brand-new board for today rather
    // than restore yesterday's expired session.
    await page.reload();
    await expect(page).toHaveURL(/\/play\/daily$/);
    await expect(page.getByTestId('game-score')).toHaveText('0');
    await expect
      .poll(() =>
        page.evaluate(
          (key) => sessionStorage.getItem(key),
          'block-blast-active-game'
        )
      )
      .toBeNull();

    expect(errors).toEqual([]);
  });

  test('does not settle a run after the player confirms exit mid-animation', async ({
    page,
  }) => {
    // Install a controllable clock so the clear-effect delay can be advanced
    // manually later. The clock is only paused once the board is ready, so page
    // load and navigation still run naturally.
    await page.clock.install({ time: new Date(2026, 6, 18, 10, 0, 0) });
    const errors = await openHome(page);

    await page.evaluate(() => {
      localStorage.setItem('block-blast-best-score', '500');
      localStorage.setItem('block-blast-score-history', '[]');
    });

    // A complete top row (clear on the next placement) plus a score one clear
    // short of the daily goal, so the next move schedules a delayed
    // challenge-completion settlement behind the clear animation.
    const seeded = buildSeededSession('daily', '2026-07-18', 997, 1);
    seeded.board[0] = ['red', 'red', 'red', 'red', 'red', 'red', 'red', null];
    await seedActiveGame(page, seeded);
    await page.goto('/play/daily');
    await expect(page.getByTestId('game-score')).toHaveText('997');
    await expect(page.getByTestId('block-game')).toHaveAttribute(
      'data-ready',
      'true'
    );
    // Freeze time now: the delayed settlement cannot fire between the
    // placement and the exit clicks below.
    await page.clock.pauseAt(new Date(2026, 6, 18, 10, 0, 2));

    // Place into the last empty cell of the top row. This clears a line and
    // schedules the challenge-completion settlement behind the animation.
    await placePiece(page, 0, 0, 7);
    await expect(page.getByTestId('clear-effect')).toHaveAttribute(
      'data-line-count',
      '1'
    );
    await expect(page.getByTestId('game-score')).toHaveText('1008');

    // Confirm exit while the settlement is still pending.
    await page.getByRole('button', { name: 'Back to mode menu' }).click();
    await page.getByRole('button', { name: 'Exit game' }).click();
    await expect(page.getByTestId('start-classic')).toBeVisible();

    // Snapshot everything the pending settlement could touch immediately after
    // exit. The placement above already updated the best score in memory, which
    // is expected; the point is that nothing in this snapshot changes once the
    // settlement's deadline passes.
    const atExit = await page.evaluate(() => ({
      session: sessionStorage.getItem('block-blast-active-game'),
      best: localStorage.getItem('block-blast-best-score'),
      history: localStorage.getItem('block-blast-score-history'),
    }));
    expect(atExit.session).toBeNull();
    expect(atExit.history).toBe('[]');

    // Let the clear-effect deadline pass. The cancelled settlement must not
    // complete the challenge, record a score, write a session, or show the
    // completion modal.
    await page.clock.fastForward(1000);
    await expect(
      page.getByRole('heading', { name: 'Challenge complete!' })
    ).toHaveCount(0);
    const settled = await page.evaluate(() => ({
      session: sessionStorage.getItem('block-blast-active-game'),
      best: localStorage.getItem('block-blast-best-score'),
      history: localStorage.getItem('block-blast-score-history'),
    }));
    expect(settled).toEqual(atExit);

    expect(errors).toEqual([]);
  });
});
