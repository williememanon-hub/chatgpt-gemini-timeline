/**
 * Folder Manager - 文件夹管理器
 * 
 * 功能：
 * - parentId 邻接表存储，读取时构建任意层级的目录树
 * - 创建、编辑、删除文件夹
 * - 移动收藏项到文件夹
 * - 按文件夹分组展示
 */

class FolderManager {
    constructor(storageAdapter) {
        this.storage = storageAdapter;
    }
    
    /**
     * 获取所有文件夹
     * @returns {Promise<Array>}
     */
    async getFolders() {
        const data = await this.storage.get('folders');
        return Array.isArray(data) ? data : [];
    }

    _compareOrder(a, b) {
        return (a.order || 0) - (b.order || 0);
    }

    _compareFolders(a, b) {
        return Number(!!b.pinned) - Number(!!a.pinned) || this._compareOrder(a, b);
    }

    /**
     * 构建一个无环的内存视图，不改写存储。旧数据中缺失的 parentId 按根处理；
     * 悬空父级、循环链中的一条边按根处理，使已有文件夹及收藏仍可访问。
     */
    _buildFolderIndex(folders) {
        const byId = new Map(folders.map(folder => [folder.id, {
            ...folder, parentId: folder.parentId || null, children: [], items: []
        }]));
        const checked = new Set();
        for (const folder of byId.values()) {
            let current = folder;
            const path = new Set();
            while (current && !checked.has(current.id)) {
                path.add(current.id);
                const parent = byId.get(current.parentId);
                if (!parent || path.has(parent.id)) {
                    current.parentId = null;
                    break;
                }
                current = parent;
            }
            for (const id of path) checked.add(id);
        }
        for (const folder of byId.values()) {
            if (folder.parentId !== null) byId.get(folder.parentId).children.push(folder);
        }
        for (const folder of byId.values()) {
            folder.children.sort((a, b) => this._compareFolders(a, b));
        }
        return byId;
    }

    /** 纯文件夹树，也供收藏弹窗使用，不必读取全部收藏。 */
    async getFolderTree() {
        return [...this._buildFolderIndex(await this.getFolders()).values()]
            .filter(folder => folder.parentId === null)
            .sort((a, b) => this._compareFolders(a, b));
    }

    /** 检查新父级的整条祖先链；folderId 为待移动文件夹。 */
    _validateParent(folders, parentId, folderId = null) {
        const byId = new Map(folders.map(folder => [folder.id, folder]));
        const visited = new Set();
        while (parentId) {
            if (parentId === folderId || visited.has(parentId)) return 'cycle';
            const parent = byId.get(parentId);
            if (!parent) return 'Target not found';
            visited.add(parentId);
            parentId = parent.parentId || null;
        }
        return null;
    }

    _reindexSiblings(folders, parentId, excludeId = null) {
        const siblings = folders.filter(folder =>
            (folder.parentId || null) === parentId && folder.id !== excludeId
        ).sort((a, b) => this._compareOrder(a, b));
        siblings.forEach((folder, index) => { folder.order = index; });
        return siblings;
    }

    async _validateStarredTarget(folderId) {
        if (folderId && !(await this.getFolders()).some(folder => folder.id === folderId)) {
            throw new Error('目标文件夹不存在');
        }
    }
    
    /**
     * 创建文件夹
     * @param {string} name - 文件夹名称
     * @param {string|null} parentId - 父文件夹 ID（null = 根文件夹）
     * @param {string} icon - emoji 图标
     * @returns {Promise<Object>} 新创建的文件夹
     */
    async createFolder(name, parentId = null, icon = '') {
        const folders = await this.getFolders();
        parentId = parentId || null;
        const error = this._validateParent(folders, parentId);
        if (error) throw new Error(error);
        
        // 计算当前层级的 order
        const siblings = this._reindexSiblings(folders, parentId);
        
        const newFolder = {
            id: `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name,
            icon,
            parentId,
            createdAt: Date.now(),
            order: siblings.length
        };
        
        folders.push(newFolder);
        await this.storage.set('folders', folders);
        
        return newFolder;
    }
    
    /**
     * 编辑文件夹
     * @param {string} folderId - 文件夹 ID
     * @param {string} newName - 新名称
     * @param {string} [newIcon] - 新 emoji 图标（可选）
     */
    async updateFolder(folderId, newName, newIcon) {
        const folders = await this.getFolders();
        const folder = folders.find(f => f.id === folderId);
        
        if (!folder) {
            throw new Error('文件夹不存在');
        }
        
        folder.name = newName;
        if (newIcon !== undefined) folder.icon = newIcon;
        await this.storage.set('folders', folders);
        
    }
    
    /**
     * 删除文件夹
     * @param {string} folderId - 要删除的文件夹 ID
     * @param {Object} [options]
     * @param {boolean} [options.deleteItems=true] - true: 连同收藏项一起删除; false: 移到未分类
     */
    async deleteFolder(folderId, options = {}) {
        const { deleteItems = true } = options;
        const folders = await this.getFolders();
        const folderToDelete = folders.find(f => f.id === folderId);
        
        if (!folderToDelete) {
            throw new Error('文件夹不存在');
        }
        
        // 显式栈是递归遍历的等价写法，visited 防止旧坏数据导致死循环。
        const children = new Map();
        for (const folder of folders) {
            if (!children.has(folder.parentId)) children.set(folder.parentId, []);
            children.get(folder.parentId).push(folder.id);
        }
        const deletedIds = new Set();
        const pending = [folderId];
        while (pending.length > 0) {
            const id = pending.pop();
            if (deletedIds.has(id)) continue;
            deletedIds.add(id);
            for (const childId of children.get(id) || []) pending.push(childId);
        }
        const newFolders = folders.filter(folder => !deletedIds.has(folder.id));
        this._reindexSiblings(newFolders, folderToDelete.parentId || null);
        await this.storage.set('folders', newFolders);
        
        await StarStorageManager.batchUpdate(items => {
            if (deleteItems) {
                return items.filter(item => !deletedIds.has(item.folderId));
            }
            return items.map(item => {
                if (deletedIds.has(item.folderId)) {
                    return { ...item, folderId: null };
                }
                return item;
            });
        });
        
    }
    
    /**
     * 移动收藏项到文件夹
     * @param {string} turnId - 收藏项 ID（格式：url:index）
     * @param {string|null} targetFolderId - 目标文件夹 ID（null = 未分类）
     */
    async moveStarredToFolder(turnId, targetFolderId) {
        await this._validateStarredTarget(targetFolderId);
        // 构建原始的 storage key: chatTimelineStar:url:index
        const key = `chatTimelineStar:${turnId}`;
        const item = await StarStorageManager.findByKey(key);
        
        if (!item) {
            throw new Error('收藏项不存在');
        }
        
        // 更新 folderId 字段
        await StarStorageManager.update(key, { folderId: targetFolderId || null });
        
    }
    
    /**
     * 按文件夹分组收藏项（树状结构）
     * @returns {Promise<Object>} 分组后的数据
     */
    async getStarredByFolder() {
        const folders = await this.getFolders();
        
        // 使用 StarStorageManager 获取所有收藏项
        const starredItemsArray = await StarStorageManager.getAll();
        
        // ✅ 辅助函数：从 item 中提取信息
        // ⚠️ 重要：turnId 必须从 item.key 中解析，确保 handleUnstar 时能正确删除
        const extractItemInfo = (item) => {
            const key = item.key || '';
            // key 格式：chatTimelineStar:{urlWithoutProtocol}:{nodeKey}
            const keyWithoutPrefix = key.replace('chatTimelineStar:', '');
            const lastColonIndex = keyWithoutPrefix.lastIndexOf(':');
            
            let urlWithoutProtocol, nodeKeyStr;
            if (lastColonIndex === -1) {
                // 异常情况：没有冒号分隔
                urlWithoutProtocol = keyWithoutPrefix;
                nodeKeyStr = '';
            } else {
                urlWithoutProtocol = keyWithoutPrefix.substring(0, lastColonIndex);
                nodeKeyStr = keyWithoutPrefix.substring(lastColonIndex + 1);
            }
            
            // 优先使用 item 中的 nodeId/index
            const nodeKey = item.nodeId !== undefined ? item.nodeId : item.index;
            
            // ⚠️ turnId 必须用 nodeKeyStr（原始字符串），确保和 Storage Key 完全一致
            const turnId = `${urlWithoutProtocol}:${nodeKeyStr}`;
            return { urlWithoutProtocol, nodeKey, turnId };
        };
        
        const mapItem = (item, info) => ({
            turnId: info.turnId,
            url: item.url || `https://${info.urlWithoutProtocol}`,
            urlWithoutProtocol: info.urlWithoutProtocol,
            index: info.nodeKey, nodeId: info.nodeKey,
            theme: item.question || '整个对话',
            timestamp: item.timestamp || 0,
            folderId: item.folderId,
            pinned: !!item.pinned
        });

        const sortItems = (arr) => arr.sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return 0;
        });

        // 构建树状结构
        const tree = {
            folders: [],      // 根文件夹列表
            uncategorized: [] // 未分类收藏项（默认文件夹）
        };
        
        // 每个节点都有 children/items；每个收藏按 folderId 只分配一次。
        const byId = this._buildFolderIndex(folders);
        tree.folders = [...byId.values()].filter(folder => folder.parentId === null)
            .sort((a, b) => this._compareFolders(a, b));
        for (const item of starredItemsArray) {
            const target = byId.get(item.folderId);
            (target ? target.items : tree.uncategorized).push(mapItem(item, extractItemInfo(item)));
        }
        for (const folder of byId.values()) sortItems(folder.items);
        sortItems(tree.uncategorized);
        
        
        return tree;
    }
    
    /**
     * 获取文件夹路径（用于显示）
     * @param {string} folderId - 文件夹 ID
     * @returns {Promise<string>} 文件夹路径，如 "工作/重要项目"
     */
    async getFolderPath(folderId) {
        if (!folderId) return '';
        
        const byId = this._buildFolderIndex(await this.getFolders());
        const names = [];
        let folder = byId.get(folderId);
        while (folder) {
            names.push(folder.name);
            folder = byId.get(folder.parentId);
        }
        return names.reverse().join(' / ');
    }
    
    /**
     * 检查文件夹名称是否已存在（同级）
     * @param {string} name - 文件夹名称
     * @param {string|null} parentId - 父文件夹 ID
     * @param {string|null} excludeId - 排除的文件夹 ID（用于编辑时）
     * @returns {Promise<boolean>}
     */
    async isFolderNameExists(name, parentId = null, excludeId = null) {
        const folders = await this.getFolders();
        const siblings = folders.filter(f => 
            (f.parentId || null) === (parentId || null) &&
            f.id !== excludeId
        );
        
        return siblings.some(f => f.name === name);
    }

    /**
     * 在文件夹内重新排列收藏项位置（基于 storage 数组顺序）
     * @param {string} turnId - 被拖拽项的 turnId
     * @param {string|null} targetFolderId - 目标文件夹 ID
     * @param {string|null} refTurnId - 参考项的 turnId（null = 放到末尾）
     * @param {'before'|'after'} position - 放在参考项前面还是后面
     */
    async reorderStarredInFolder(turnId, targetFolderId, refTurnId, position) {
        await this._validateStarredTarget(targetFolderId);
        if (turnId === refTurnId) return;
        const srcKey = `chatTimelineStar:${turnId}`;
        await StarStorageManager.batchUpdate(items => {
            const srcIdx = items.findIndex(i => i.key === srcKey);
            if (srcIdx === -1) return items;

            const [item] = items.splice(srcIdx, 1);
            item.folderId = targetFolderId || null;

            if (!refTurnId) {
                items.push(item);
                return items;
            }

            const refKey = `chatTimelineStar:${refTurnId}`;
            const refIdx = items.findIndex(i => i.key === refKey &&
                (i.folderId || null) === (targetFolderId || null));
            if (refIdx === -1) { items.push(item); return items; }

            const insertIdx = position === 'before' ? refIdx : refIdx + 1;
            items.splice(insertIdx, 0, item);
            return items;
        });
    }

    /**
     * 移动到目标前后；跨级时同时改为目标的父级，整棵子树随之移动。
     * @param {string} folderId - 要移动的文件夹 ID
     * @param {string} targetFolderId - 目标文件夹 ID
     * @param {'before'|'after'} position - 插入到目标的前面还是后面
     */
    async moveFolderToPosition(folderId, targetFolderId, position) {
        const folders = await this.getFolders();
        const folder = folders.find(f => f.id === folderId);
        const target = folders.find(f => f.id === targetFolderId);
        if (!folder || !target) return { ok: false, error: 'Folder not found' };
        if (folderId === targetFolderId) return { ok: true };
        if (position !== 'before' && position !== 'after') return { ok: false, error: 'Invalid position' };
        const parentId = target.parentId || null;
        const error = this._validateParent(folders, parentId, folderId);
        if (error) return { ok: false, error };

        const oldParentId = folder.parentId || null;
        const siblings = this._reindexSiblings(folders, parentId, folderId);
        const toIdx = siblings.findIndex(f => f.id === targetFolderId);
        const insertIdx = position === 'before' ? toIdx : toIdx + 1;
        folder.parentId = parentId;
        siblings.splice(insertIdx, 0, folder);
        siblings.forEach((sibling, index) => { sibling.order = index; });
        if (oldParentId !== parentId) {
            this._reindexSiblings(folders, oldParentId);
        }
        await this.storage.set('folders', folders);
        return { ok: true };
    }

    /**
     * 移动文件夹到新的父级（跨级拖拽）
     * @param {string} folderId - 要移动的文件夹 ID
     * @param {string|null} newParentId - 新父文件夹 ID（null = 移到根级别）
     * @returns {Promise<{ok:boolean, error?:string}>}
     */
    async moveFolderToParent(folderId, newParentId) {
        const folders = await this.getFolders();
        const folder = folders.find(f => f.id === folderId);
        if (!folder) return { ok: false, error: 'Folder not found' };

        newParentId = newParentId || null;
        const error = this._validateParent(folders, newParentId, folderId);
        if (error) return { ok: false, error };
        if ((folder.parentId || null) === newParentId) return { ok: true };

        const oldParentId = folder.parentId || null;
        folder.parentId = newParentId;
        const newSiblings = this._reindexSiblings(folders, newParentId, folderId);
        folder.order = newSiblings.length;
        this._reindexSiblings(folders, oldParentId);

        await this.storage.set('folders', folders);
        return { ok: true };
    }

    async togglePinFolder(folderId) {
        const folders = await this.getFolders();
        const folder = folders.find(f => f.id === folderId);
        if (!folder) return;
        folder.pinned = !folder.pinned;
        await this.storage.set('folders', folders);
    }

    async togglePinStarred(turnId) {
        const key = `chatTimelineStar:${turnId}`;
        const item = await StarStorageManager.findByKey(key);
        if (!item) return;
        await StarStorageManager.update(key, { pinned: !item.pinned });
    }
}

