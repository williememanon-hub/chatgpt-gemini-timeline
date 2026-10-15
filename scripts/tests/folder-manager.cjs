const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, plain, folder, chain, star, flatten } = require('./helpers/folder-harness.cjs');

test('create seven levels, retain every star exactly once, and reload without migration', async () => {
    const { manager, stars, storage, reload } = setup();
    const created = [];
    for (let i = 0; i < 7; i++) {
        const parent = created.at(-1)?.id || null;
        const next = await manager.createFolder(`第${i + 1}层`, parent, '📁');
        created.push(next);
        await stars.add(star(i, next.id));
    }
    const tree = await reload().getStarredByFolder();
    const nodes = flatten(tree.folders);
    assert.equal(nodes.length, 7);
    assert.equal(tree.uncategorized.length, 0);
    for (let i = 0; i < nodes.length; i++) {
        assert.equal(nodes[i].id, created[i].id);
        assert.equal(nodes[i].items.length, 1);
        assert.equal(nodes[i].items[0].folderId, created[i].id);
    }
    assert.equal(await manager.getFolderPath(created[6].id), created.map(f => f.name).join(' / '));
    assert.deepEqual(Object.keys(storage.data).sort(), ['chatTimelineStars', 'folders']);
    assert(storage.data.folders.every(f => !('children' in f) && !('items' in f)));
});

test('creation rejects missing parents and pre-existing cycles without writes', async () => {
    const { manager, storage } = setup({ folders: [folder('A', 'B'), folder('B', 'A')] });
    await assert.rejects(() => manager.createFolder('lost', 'missing'));
    await assert.rejects(() => manager.createFolder('cycle-child', 'A'));
    assert.equal(storage.writes.length, 0);
});

test('moving a whole subtree into level seven preserves descendants and star ownership', async () => {
    const originalStar = star('leaf', 'child', { customMetadata: { keep: true } });
    const { manager, storage } = setup({ folders: [
        ...chain(), folder('source', null, 9), folder('child', 'source'),
        folder('old-sibling', null, 20), folder('target-sibling', 'L7', 90)
    ], chatTimelineStars: [originalStar] });
    assert.equal((await manager.moveFolderToParent('source', 'L7')).ok, true);
    assert.equal(await manager.getFolderPath('child'), 'L1 / L2 / L3 / L4 / L5 / L6 / L7 / source / child');
    assert.equal(storage.data.folders.find(f => f.id === 'source').order, 1);
    assert.equal(storage.data.folders.find(f => f.id === 'target-sibling').order, 0);
    assert.equal(storage.data.folders.find(f => f.id === 'old-sibling').order, 1);
    assert.deepEqual(storage.data.chatTimelineStars, [originalStar]);
    await manager.moveFolderToParent('source', null);
    assert.equal(await manager.getFolderPath('child'), 'source / child');
});

test('self/descendant moves, descendant-relative sorting and corrupt targets cannot create cycles', async () => {
    const { manager, storage } = setup({ folders: [...chain(), folder('A', 'B'), folder('B', 'A')] });
    const before = plain(storage.data);
    for (const [source, target] of [['L1', 'L1'], ['L1', 'L7'], ['L3', 'L7'], ['L1', 'A'], ['L7', 'missing']]) {
        assert.equal((await manager.moveFolderToParent(source, target)).ok, false);
    }
    for (const position of ['before', 'after']) {
        assert.equal((await manager.moveFolderToPosition('L1', 'L7', position)).ok, false);
    }
    assert.deepEqual(storage.data, before);
    assert.equal(storage.writes.length, 0);
});

test('cross-level before/after placement and deep sibling reorder keep both sibling lists ordered', async () => {
    const { manager, storage } = setup({ folders: [
        ...chain(), folder('A', 'L7', 10), folder('B', 'L7', 20),
        folder('move', null, 5), folder('leaf', 'move')
    ] });
    await manager.moveFolderToPosition('move', 'B', 'before');
    let deep = flatten((await manager.getStarredByFolder()).folders).find(f => f.id === 'L7');
    assert.deepEqual(Array.from(deep.children, f => f.id), ['A', 'move', 'B']);
    await manager.moveFolderToPosition('A', 'B', 'after');
    deep = flatten((await manager.getStarredByFolder()).folders).find(f => f.id === 'L7');
    assert.deepEqual(Array.from(deep.children, f => f.id), ['move', 'B', 'A']);
    assert.deepEqual(Array.from(deep.children, f => f.order), [0, 1, 2]);
    await manager.moveFolderToPosition('move', 'L1', 'after');
    assert.equal(await manager.getFolderPath('leaf'), 'move / leaf');
    assert.deepEqual(storage.data.folders.filter(f => f.parentId === 'L7').map(f => f.order).sort(), [0, 1]);
});

test('pin sorting applies at every depth and stable item order survives a cross-folder reorder', async () => {
    const { manager, storage } = setup({ folders: [
        ...chain(), folder('normal', 'L7', 0), folder('pinned', 'L7', 99, { pinned: true })
    ], chatTimelineStars: [star('a', 'L7'), star('b', 'L7'), star('pin', 'L7', { pinned: true }), star('other', 'L1')] });
    let deep = flatten((await manager.getStarredByFolder()).folders).find(f => f.id === 'L7');
    assert.deepEqual(Array.from(deep.children, f => f.id), ['pinned', 'normal']);
    await manager.reorderStarredInFolder('chatgpt.com/c/test:other', 'L7', 'chatgpt.com/c/test:b', 'before');
    deep = flatten((await manager.getStarredByFolder()).folders).find(f => f.id === 'L7');
    assert.deepEqual(Array.from(deep.items, i => i.index), ['pin', 'a', 'other', 'b']);
    const before = plain(storage.data);
    await manager.reorderStarredInFolder('chatgpt.com/c/test:b', 'L7', 'chatgpt.com/c/test:b', 'after');
    assert.deepEqual(storage.data, before);
});

test('recursive deletion removes all branches and descendants but keeps unrelated data', async () => {
    const folders = [...chain(), folder('branch', 'L3'), folder('branch-leaf', 'branch'), folder('outside')];
    const items = folders.map(f => star(f.id, f.id));
    const { manager, storage } = setup({ folders, chatTimelineStars: [...items, star('uncategorized', null)] });
    await manager.deleteFolder('L3');
    assert.deepEqual(storage.data.folders.map(f => f.id), ['L1', 'L2', 'outside']);
    assert.deepEqual(storage.data.chatTimelineStars.map(i => i.index), ['L1', 'L2', 'outside', 'uncategorized']);
    await manager.deleteFolder('L1');
    assert.deepEqual(storage.data.folders.map(f => f.id), ['outside']);
});

test('deleteItems:false uncategorizes ALL descendant stars without changing their payload', async () => {
    const items = chain().map(f => star(f.id, f.id, { note: '<keep>', pinned: true }));
    const { manager, storage } = setup({ folders: chain(), chatTimelineStars: items });
    await manager.deleteFolder('L1', { deleteItems: false });
    assert.deepEqual(storage.data.folders, []);
    assert.deepEqual(storage.data.chatTimelineStars, items.map(i => ({ ...i, folderId: null })));
    assert.equal((await manager.getStarredByFolder()).uncategorized.length, 7);
});

test('paths follow renamed and moved ancestors, and nonexistent paths stay empty', async () => {
    const { manager } = setup({ folders: [...chain(), folder('new-root')] });
    await manager.updateFolder('L2', '学习');
    await manager.moveFolderToParent('L2', 'new-root');
    assert.equal(await manager.getFolderPath('L7'), 'new-root / 学习 / L3 / L4 / L5 / L6 / L7');
    assert.equal(await manager.getFolderPath(null), '');
    assert.equal(await manager.getFolderPath('missing'), '');
});

test('legacy two-level/missing-parentId data, node IDs and notepad storage keys remain compatible', async () => {
    const legacyRoot = { id: 'legacy-root', name: '旧目录', custom: { keep: true } };
    const data = { folders: [legacyRoot, folder('legacy-child', 'legacy-root')], chatTimelineStars: [
        star(0, 'legacy-root'),
        star('node-uuid', 'legacy-child', { nodeId: 'node-uuid' }),
        star('orphan-item', 'deleted'),
        star('no-folder', undefined),
        { key: 'chatTimelineStar:notepad:note:abc', folderId: 'legacy-child', question: 'note' }
    ] };
    const { manager, storage } = setup(data);
    const tree = await manager.getStarredByFolder();
    assert.equal(tree.folders[0].name, '旧目录');
    assert.equal(tree.folders[0].children[0].items[0].turnId, 'chatgpt.com/c/test:node-uuid');
    assert.equal(tree.folders[0].children[0].items[1].turnId, 'notepad:note:abc');
    assert.equal(tree.uncategorized.length, 2);
    assert.equal(await manager.getFolderPath('legacy-child'), '旧目录 / legacy-child');
    assert.equal(await manager.isFolderNameExists('旧目录'), true);
    assert.deepEqual(storage.data, data);
    assert.equal(storage.writes.length, 0);
});

test('orphan/cyclic imported folders remain visible exactly once; reads never rewrite data', async () => {
    const data = { folders: [folder('orphan', 'missing'), folder('A', 'B'), folder('B', 'A'), folder('self', 'self')],
        chatTimelineStars: [star('a', 'A'), star('b', 'B'), star('o', 'orphan'), star('s', 'self')] };
    const { manager, storage } = setup(data);
    const tree = await manager.getStarredByFolder();
    const nodes = flatten(tree.folders);
    assert.equal(new Set(nodes.map(f => f.id)).size, 4);
    assert.equal(nodes.reduce((count, f) => count + f.items.length, 0), 4);
    assert.equal(tree.uncategorized.length, 0);
    assert.equal(await manager.getFolderPath('A'), 'B / A');
    assert.deepEqual(storage.data, data);
    assert.equal(storage.writes.length, 0);
    // Deletion also terminates on the original cyclic storage graph.
    await manager.deleteFolder('A');
    assert.deepEqual(storage.data.folders.map(f => f.id), ['orphan', 'self']);
});

test('star moves reject missing folders, preserve node keys, and support uncategorized', async () => {
    const { manager, storage } = setup({ folders: chain(), chatTimelineStars: [star('uuid', 'L1', { nodeId: 'uuid' })] });
    const before = plain(storage.data);
    await assert.rejects(() => manager.moveStarredToFolder('chatgpt.com/c/test:uuid', 'missing'));
    await assert.rejects(() => manager.reorderStarredInFolder('chatgpt.com/c/test:uuid', 'missing', null, 'after'));
    assert.deepEqual(storage.data, before);
    await manager.moveStarredToFolder('chatgpt.com/c/test:uuid', 'L7');
    assert.equal(storage.data.chatTimelineStars[0].folderId, 'L7');
    await manager.moveStarredToFolder('chatgpt.com/c/test:uuid', null);
    assert.equal(storage.data.chatTimelineStars[0].folderId, null);
    assert.equal(storage.data.chatTimelineStars[0].key, before.chatTimelineStars[0].key);
});

test('128-level imported tree builds, computes paths and deletes without a fixed depth limit', async () => {
    const { manager, storage } = setup({ folders: chain(128), chatTimelineStars: [star('deep', 'L128')] });
    assert.equal(flatten(await manager.getFolderTree()).length, 128);
    assert.equal((await manager.getFolderPath('L128')).split(' / ').length, 128);
    await manager.deleteFolder('L1');
    assert.deepEqual(storage.data, { folders: [], chatTimelineStars: [] });
});
