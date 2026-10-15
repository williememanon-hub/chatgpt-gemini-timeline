const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.env.TIMELINE_SOURCE_ROOT || path.resolve(__dirname, '../../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const plain = value => structuredClone(value);

// Clone on both sides, as chrome.storage does: a failed operation must not
// accidentally modify the persisted object through a shared reference.
class MockStorageAdapter {
    constructor(data = {}) { this.data = plain(data); this.writes = []; }
    async get(key) { return plain(this.data[key]); }
    async set(key, value) {
        this.data[key] = plain(value);
        this.writes.push({ key, value: plain(value) });
    }
}

function setup(data = {}) {
    const storage = new MockStorageAdapter(data);
    const context = vm.createContext({ console, setTimeout, clearTimeout, storage });
    // Load the real StarStorageManager, then substitute only its I/O adapter.
    vm.runInContext(read('js/timeline/common.js') + `
        StorageAdapter.get = storage.get.bind(storage);
        StorageAdapter.set = storage.set.bind(storage);
        globalThis.stars = StarStorageManager;
    `, context);
    vm.runInContext(read('js/panelModal/tabs/starred/folder-manager.js') + `
        globalThis.manager = new FolderManager(StorageAdapter);
        globalThis.reload = () => new FolderManager(StorageAdapter);
    `, context);
    return { storage, manager: context.manager, stars: context.stars, reload: context.reload };
}

function folder(id, parentId = null, order = 0, extra = {}) {
    return { id, name: id, icon: '', parentId, order, createdAt: 1, ...extra };
}

function chain(depth = 7) {
    return Array.from({ length: depth }, (_, i) => folder(`L${i + 1}`, i ? `L${i}` : null));
}

function star(id, folderId, extra = {}) {
    return { key: `chatTimelineStar:chatgpt.com/c/test:${id}`, index: id,
        url: 'https://chatgpt.com/c/test', question: `Question ${id}`,
        timestamp: 123, folderId, ...extra };
}

function flatten(folders) {
    return folders.flatMap(folder => [folder, ...flatten(folder.children || [])]);
}

module.exports = { root, read, plain, setup, MockStorageAdapter, folder, chain, star, flatten };
