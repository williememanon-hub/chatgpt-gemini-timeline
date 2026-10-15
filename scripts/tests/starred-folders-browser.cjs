const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { root, read, chain, folder, star } = require('./helpers/folder-harness.cjs');

let browser;
before(async () => {
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
});
after(async () => { await browser?.close(); });

async function pageFor(t, data = { folders: chain(), chatTimelineStars: [star('deep', 'L7')] }) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    t.after(() => page.close());
    page.testErrors = [];
    page.on('pageerror', e => page.testErrors.push(e.message));
    t.after(() => assert.deepEqual(page.testErrors, [], 'No uncaught browser errors'));
    // A local fixture at a fake ChatGPT URL. No signed-in account or live network.
    await page.route('https://chatgpt.com/**', route => route.fulfill({
        contentType: 'text/html', body: `<!doctype html><html><body style="margin:0">
        <div style="display:flex;width:100vw;height:100vh">
          <aside id="native-sidebar" style="width:280px;flex:0 0 280px">
            <nav style="display:flex;flex-direction:column;overflow:auto;height:100vh">
              <div id="native-top" style="height:80px;flex-shrink:0">Native navigation</div>
              <section class="group/sidebar-expando-section" id="native-history">
                <a data-sidebar-item href="/c/native-drag">Native conversation</a>
              </section>
            </nav>
          </aside><main style="flex:1;min-width:0">Native ChatGPT content fixture</main>
        </div></body></html>`
    }));
    await page.goto('https://chatgpt.com/c/test');
    const styles = [
        'styles/variables.css', 'js/sidebarStarred/styles.css',
        'js/panelModal/tabs/starred/styles.css', 'js/global/dropdown-manager/styles.css',
        'js/timeline/star-input-modal/star-input-modal.css',
        'js/sidebarStarred/folder-edit-modal/styles.css', 'js/global/popconfirm-manager/styles.css'
    ];
    for (const file of styles) await page.addStyleTag({ content: read(file) });
    await page.addScriptTag({ content: read('js/timeline/common.js') });
    await page.evaluate(data => {
        window.testData = structuredClone(data);
        window.testWrites = [];
        StorageAdapter.get = async key => structuredClone(window.testData[key]);
        StorageAdapter.set = async (key, value) => {
            window.testData[key] = structuredClone(value);
            window.testWrites.push(key);
        };
        window.TimelineI18n = { ready: async () => {}, getMessage: () => '' };
    }, data);
    for (const file of [
        'js/panelModal/tabs/starred/folder-manager.js',
        'js/sidebarStarred/starred-tree-renderer.js',
        'js/sidebarStarred/adapters/base.js', 'js/sidebarStarred/adapters/chatgpt.js',
        'js/sidebarStarred/sidebar-starred-manager.js',
        'js/global/dropdown-manager/index.js',
        'js/sidebarStarred/folder-edit-modal/index.js',
        'js/global/popconfirm-manager/index.js',
        'js/timeline/star-input-modal/star-input-modal.js'
    ]) await page.addScriptTag({ content: read(file) });
    await page.evaluate(async () => {
        window.sidebar = new SidebarStarredManager(new ChatGPTSidebarStarredAdapter());
        window.nativeWidthBefore = document.querySelector('#native-sidebar').getBoundingClientRect().width;
        sidebar._injectIntoSidebar();
        sidebar.folderStates = Object.fromEntries(testData.folders.map(f => [f.id, true]));
        await sidebar._refreshContent();
        window.fm = sidebar.folderManager;
        window.renderer = sidebar.treeRenderer;
    });
    return page;
}

async function dragFolder(page, sourceId, targetId, ratio = 0.5) {
    return page.evaluate(({ sourceId, targetId, ratio }) => {
        const source = document.querySelector(`[data-folder-id="${sourceId}"] > .ait-folder-header`);
        const target = document.querySelector(`[data-folder-id="${targetId}"] > .ait-folder-header`);
        const dataTransfer = new DataTransfer();
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
        const rect = target.getBoundingClientRect();
        const event = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer,
            clientX: rect.left + 60, clientY: rect.top + rect.height * ratio });
        target.dispatchEvent(event);
        const position = renderer._dropPosition;
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
        return { accepted: event.defaultPrevented, position };
    }, { sourceId, targetId, ratio });
}

test('seven levels scroll horizontally and vertically without widening or scrolling the native sidebar', async t => {
    const page = await pageFor(t, { folders: chain(),
        chatTimelineStars: Array.from({ length: 45 }, (_, i) => star(i, 'L7')) });
    const before = await page.evaluate(() => {
        const list = document.querySelector('.ait-ss-list');
        return { width: list.clientWidth, scrollWidth: list.scrollWidth,
            height: list.clientHeight, scrollHeight: list.scrollHeight,
            nativeWidth: document.querySelector('#native-sidebar').getBoundingClientRect().width,
            nativeScrollWidth: document.querySelector('nav').scrollWidth,
            nativeClientWidth: document.querySelector('nav').clientWidth,
            originalWidth: nativeWidthBefore,
            positionCorrect: sidebar.container.nextElementSibling.id === 'native-history' };
    });
    assert(before.scrollWidth > before.width);
    assert(before.scrollHeight > before.height);
    assert.equal(before.nativeWidth, before.originalWidth);
    assert(before.nativeScrollWidth <= before.nativeClientWidth + 1);
    assert.equal(before.positionCorrect, true);
    await page.locator('.ait-ss-list').hover({ position: { x: 100, y: 150 } });
    await page.mouse.wheel(500, 0);
    await page.waitForFunction(() => document.querySelector('.ait-ss-list').scrollLeft > 0);
    const after = await page.evaluate(() => {
        const list = document.querySelector('.ait-ss-list');
        list.scrollLeft = list.scrollWidth;
        list.scrollTop = list.scrollHeight;
        const row = list.querySelector('.timeline-starred-item:last-child').getBoundingClientRect();
        const viewport = list.getBoundingClientRect();
        return { rowLeft: row.left, rowRight: row.right, left: viewport.left, right: viewport.right,
            nativeScrollLeft: document.querySelector('nav').scrollLeft,
            nativeWidth: document.querySelector('#native-sidebar').getBoundingClientRect().width };
    });
    assert(after.rowLeft >= after.left - 1 && after.rowRight <= after.right + 1);
    assert.equal(after.nativeScrollLeft, 0);
    assert.equal(after.nativeWidth, 280);
    if (process.env.TIMELINE_TEST_ARTIFACTS) {
        fs.mkdirSync(process.env.TIMELINE_TEST_ARTIFACTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.TIMELINE_TEST_ARTIFACTS, 'seven-level-sidebar.png') });
        await page.evaluate(() => { document.querySelector('.ait-ss-list').scrollTop = 0; });
        await page.screenshot({ path: path.join(process.env.TIMELINE_TEST_ARTIFACTS, 'seven-level-folders.png') });
    }
});

test('long deep names stay on one row and narrow/dark sidebars keep their assigned width', async t => {
    const folders = chain();
    folders[6].name = 'A long folder title '.repeat(20);
    const page = await pageFor(t, { folders, chatTimelineStars: [star('deep', 'L7')] });
    for (const width of [220, 280, 340]) {
        const metrics = await page.evaluate(width => {
            const native = document.querySelector('#native-sidebar');
            native.style.width = `${width}px`; native.style.flexBasis = `${width}px`;
            document.documentElement.setAttribute('data-timeline-theme', 'dark');
            const list = document.querySelector('.ait-ss-list');
            const header = document.querySelector('[data-folder-id="L7"] > .ait-folder-header');
            const name = header.querySelector('.ait-folder-name');
            return { width: native.getBoundingClientRect().width,
                nativeOverflow: document.querySelector('nav').scrollWidth - document.querySelector('nav').clientWidth,
                localOverflow: list.scrollWidth - list.clientWidth,
                ellipsis: getComputedStyle(name).textOverflow,
                truncated: name.scrollWidth > name.clientWidth,
                rowHeight: header.getBoundingClientRect().height };
        }, width);
        assert.equal(metrics.width, width);
        assert(metrics.nativeOverflow <= 1);
        assert(metrics.localOverflow > 0);
        assert.equal(metrics.ellipsis, 'ellipsis');
        assert.equal(metrics.truncated, true);
        assert(metrics.rowHeight < 45);
    }
});

test('refresh retains scroll position; collapsing deep branches removes unnecessary overflow', async t => {
    const page = await pageFor(t, { folders: chain(),
        chatTimelineStars: Array.from({ length: 45 }, (_, i) => star(i, 'L7')) });
    const positions = await page.evaluate(async () => {
        const list = document.querySelector('.ait-ss-list');
        list.scrollLeft = 80; list.scrollTop = 200;
        const before = { x: list.scrollLeft, y: list.scrollTop };
        await sidebar._refreshContent();
        const after = { x: list.scrollLeft, y: list.scrollTop };
        renderer.toggleFolder('L1');
        const collapsed = list.scrollWidth <= list.clientWidth + 1;
        await sidebar._toggleCollapse();
        return { before, after, collapsed, hidden: getComputedStyle(list).display === 'none' };
    });
    assert.deepEqual(positions.before, positions.after);
    assert.equal(positions.collapsed, true);
    assert.equal(positions.hidden, true);
});

test('delegated folder drag/drop supports deep targets, sibling nesting and promotion to root', async t => {
    const page = await pageFor(t, { folders: [...chain(), folder('loose'), folder('leaf', 'loose'), folder('sibling')],
        chatTimelineStars: [star('leaf', 'leaf')] });
    assert.deepEqual(await dragFolder(page, 'loose', 'L7'), { accepted: true, position: 'inside' });
    await page.waitForFunction(() => testData.folders.find(f => f.id === 'loose').parentId === 'L7');
    await page.waitForFunction(() => renderer._dragState === null);
    assert.equal(await page.evaluate(() => fm.getFolderPath('leaf')), 'L1 / L2 / L3 / L4 / L5 / L6 / L7 / loose / leaf');
    assert.deepEqual(await dragFolder(page, 'loose', 'L1', 0.95), { accepted: true, position: 'after' });
    await page.waitForFunction(() => testData.folders.find(f => f.id === 'loose').parentId === null);
    await page.waitForFunction(() => renderer._dragState === null);
    assert.deepEqual(await dragFolder(page, 'sibling', 'loose'), { accepted: true, position: 'inside' });
    await page.waitForFunction(() => testData.folders.find(f => f.id === 'sibling').parentId === 'loose');
    assert.equal(await page.evaluate(() => testData.chatTimelineStars[0].folderId), 'leaf');
});

test('dragging a folder onto its own descendant is refused with no persisted changes', async t => {
    const page = await pageFor(t);
    const before = await page.evaluate(() => structuredClone(testData));
    assert.deepEqual(await dragFolder(page, 'L1', 'L7'), { accepted: false, position: null });
    assert.deepEqual(await page.evaluate(() => testData), before);
    assert.equal(await page.evaluate(() => testWrites.length), 0);
});

test('deep folder action menu creates an eighth level and moves a subtree to root', async t => {
    const page = await pageFor(t);
    await page.evaluate(() => renderer._showFolderMenu(
        document.querySelector('[data-folder-id="L7"] > .ait-folder-header .ait-folder-action-btn'),
        renderer._folderDataMap.get('L7').folder));
    await page.locator('.global-dropdown-item').filter({ hasText: 'New Subfolder' }).click();
    await page.locator('.folder-edit-modal-input').fill('第八层');
    await page.locator('.folder-edit-modal-confirm').click();
    await page.waitForFunction(() => testData.folders.some(f => f.name === '第八层' && f.parentId === 'L7'));
    await page.evaluate(() => renderer._showFolderMenu(
        document.querySelector('[data-folder-id="L7"] > .ait-folder-header .ait-folder-action-btn'),
        renderer._folderDataMap.get('L7').folder));
    await page.locator('.global-dropdown-item').filter({ hasText: 'Move to root' }).click();
    await page.waitForFunction(() => testData.folders.find(f => f.id === 'L7').parentId === null);
    const path = await page.evaluate(async () => fm.getFolderPath(testData.folders.find(f => f.name === '第八层').id));
    assert.equal(path, 'L7 / 第八层');
});

test('deep delete confirmation counts all descendants and deletes the selected subtree', async t => {
    const page = await pageFor(t, { folders: chain(), chatTimelineStars: chain().map(f => star(f.id, f.id)) });
    await page.evaluate(() => { window.deletePromise = renderer.handleDeleteFolder('L3'); });
    await page.waitForSelector('.popconfirm-text');
    assert.match(await page.locator('.popconfirm-text').textContent(), /5/);
    await page.locator('.popconfirm-btn-confirm').click();
    await page.waitForFunction(() => testData.folders.length === 2);
    assert.deepEqual(await page.evaluate(() => testData.chatTimelineStars.map(i => i.folderId)), ['L1', 'L2']);
});

test('search keeps every ancestor of a match at level seven in the shared tab renderer', async t => {
    const page = await pageFor(t);
    await page.evaluate(async () => {
        renderer.opts.showSearch = true;
        renderer.opts.getSearchQuery = () => 'question deep';
        await sidebar._refreshContent();
    });
    assert.equal(await page.locator('.ait-folder-item').count(), 7);
    assert.equal(await page.locator('.timeline-starred-item').count(), 1);
    assert.equal(await page.locator('.ait-folder-content.expanded').count(), 7);
});

test('favorite modal recursively exposes all seven levels, selects the leaf and returns its ID', async t => {
    const page = await pageFor(t);
    await page.evaluate(() => { window.modalPromise = starInputModal.show({ title: 'Favorite',
        defaultValue: 'Saved title', folderManager: fm }); });
    await page.locator('.star-input-modal-folder-selector').click();
    // Real pointer hover traverses GlobalDropdownManager's nested menus,
    // exercising positioning, leave handlers and the actual selection callback.
    for (let i = 1; i < 7; i++) {
        await page.locator('.global-dropdown-item-label').filter({ hasText: new RegExp(`^L${i}$`) })
            .locator('..').hover();
        await page.waitForSelector(`.global-dropdown-submenu[data-level="${i}"]`);
    }
    await page.locator('.global-dropdown-item-label').filter({ hasText: /^L7$/ }).click();
    assert.equal(await page.locator('.star-input-modal-folder-text').textContent(), 'L1 / L2 / L3 / L4 / L5 / L6 / L7');
    await page.locator('.star-input-modal-confirm').click();
    assert.deepEqual(await page.evaluate(() => modalPromise), { value: 'Saved title', folderId: 'L7' });
});

test('custom mouse drag moves a favorite across levels using hit-testing and persists folderId', async t => {
    const page = await pageFor(t, { folders: chain(), chatTimelineStars: [star('source', 'L1')] });
    await page.evaluate(() => {
        const item = document.querySelector('.timeline-starred-item-name');
        const header = document.querySelector('[data-folder-id="L7"] > .ait-folder-header');
        const rect = item.getBoundingClientRect();
        const target = header.getBoundingClientRect();
        item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: rect.left + 5, clientY: rect.top + 5 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: target.left + 75, clientY: target.top + 10 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: target.left + 75, clientY: target.top + 10 }));
    });
    await page.waitForFunction(() => testData.chatTimelineStars[0].folderId === 'L7');
    assert.equal(await page.locator('[data-folder-id="L7"] .timeline-starred-item').count(), 1);
});

test('native sidebar conversation custom drag can reach level seven without altering native markup', async t => {
    const page = await pageFor(t, { folders: chain(), chatTimelineStars: [] });
    await page.evaluate(() => {
        sidebar._initCustomDrag();
        const native = document.querySelector('a[data-sidebar-item]');
        const before = native.outerHTML;
        const target = document.querySelector('[data-folder-id="L7"] > .ait-folder-header').getBoundingClientRect();
        native.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 25, clientY: 400 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: target.left + 75, clientY: target.top + 10 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: target.left + 75, clientY: target.top + 10 }));
        window.nativeMarkupBefore = before;
    });
    await page.waitForFunction(() => testData.chatTimelineStars.some(s => s.folderId === 'L7'));
    assert.equal(await page.locator('#native-history a').count(), 1);
    assert.equal(await page.locator('#native-history a').getAttribute('href'), '/c/native-drag');
});
