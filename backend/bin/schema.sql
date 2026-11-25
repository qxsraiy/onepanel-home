CREATE TABLE IF NOT EXISTS "ItemUrl" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "itemId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '主地址',
    "priority" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ItemUrl_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE IF NOT EXISTS "AppConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "username" TEXT NOT NULL DEFAULT 'admin',
    "password" TEXT NOT NULL,
    "isFirstLogin" BOOLEAN NOT NULL DEFAULT true,
    "webdavUrl" TEXT,
    "webdavUser" TEXT,
    "webdavPass" TEXT,
    "wechatCorpId" TEXT,
    "wechatCorpSecret" TEXT,
    "wechatAgentId" TEXT,
    "wechatTouser" TEXT DEFAULT '@all',
    "themeBg" TEXT,
    "themeColor" TEXT,
    "siteIcon" TEXT,
    "bgImage" TEXT,
    "siteTitle" TEXT,
    "footerText" TEXT,
    "groups" TEXT,
    "cardBgColor" TEXT,
    "cardBgOpacity" REAL,
    "twoFactorSecret" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false
, "vaultSalt" TEXT, "vaultWrapped" TEXT, themeAccent TEXT, uiPrefs TEXT DEFAULT '{}', tokenEpoch INTEGER DEFAULT 0);
CREATE INDEX "ItemUrl_itemId_idx" ON "ItemUrl"("itemId");
CREATE TABLE IF NOT EXISTS "Item" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL DEFAULT 'bookmark',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "openMethod" TEXT NOT NULL DEFAULT 'new_tab',
    "bgColor" TEXT,
    "bgOpacity" REAL,
    "group" TEXT NOT NULL DEFAULT '书签',
    "order" INTEGER NOT NULL DEFAULT 0,
    "gridX" INTEGER,
    "gridY" INTEGER,
    "isHidden" BOOLEAN NOT NULL DEFAULT false,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "isMonitored" BOOLEAN NOT NULL DEFAULT false,
    "pingUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
, "widgetConfig" TEXT, "widgetType" TEXT, "memo" TEXT, "uid" TEXT NOT NULL DEFAULT '', "payload" TEXT NOT NULL DEFAULT '', "hlc" TEXT NOT NULL DEFAULT '', "nodeId" TEXT NOT NULL DEFAULT '', "deletedAt" DATETIME, "dirty" BOOLEAN NOT NULL DEFAULT true, "updatedAt" DATETIME);
CREATE INDEX "Item_group_idx" ON "Item"("group");
CREATE INDEX "Item_isMonitored_idx" ON "Item"("isMonitored");
CREATE UNIQUE INDEX "Item_uid_key" ON "Item"("uid");
CREATE TABLE IF NOT EXISTS "NodeState" ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS "ChangeLog" ("nodeId" TEXT NOT NULL, "seq" INTEGER NOT NULL, "changeId" TEXT NOT NULL, "entity" TEXT NOT NULL, "uid" TEXT NOT NULL, "op" TEXT NOT NULL, "hlc" TEXT NOT NULL, "payload" TEXT, "sig" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, pk TEXT, PRIMARY KEY ("nodeId","seq"));
CREATE UNIQUE INDEX "ChangeLog_changeId_key" ON "ChangeLog"("changeId");
CREATE INDEX "ChangeLog_hlc_idx" ON "ChangeLog"("hlc");
CREATE INDEX "ChangeLog_entity_uid_idx" ON "ChangeLog"("entity","uid");
CREATE TABLE IF NOT EXISTS "AppliedChange" ("changeId" TEXT NOT NULL PRIMARY KEY, "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "PeerAck" ("peerId" TEXT NOT NULL PRIMARY KEY, "lastSeq" INTEGER NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, pulledSeq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS "Member" ("nodeId" TEXT NOT NULL PRIMARY KEY, "publicKey" TEXT NOT NULL, "selfUrls" TEXT, "role" TEXT NOT NULL DEFAULT 'peer', "status" TEXT NOT NULL DEFAULT 'active', "lastSeen" DATETIME, "lastSyncAt" DATETIME, "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, name TEXT);
CREATE TABLE IF NOT EXISTS "RemoteBlob" ("hash" TEXT NOT NULL PRIMARY KEY, "size" INTEGER NOT NULL DEFAULT 0, "uploadedBy" TEXT, "kind" TEXT NOT NULL DEFAULT 'item', "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "ItemRevision" ("id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "uid" TEXT NOT NULL, "payload" TEXT NOT NULL, "hlc" TEXT NOT NULL, "nodeId" TEXT NOT NULL, "reason" TEXT NOT NULL DEFAULT 'conflict', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "ItemRevision_uid_idx" ON "ItemRevision"("uid");
CREATE INDEX ChangeLog_createdAt_idx ON ChangeLog(createdAt);
CREATE TABLE PingHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, ok INTEGER NOT NULL, latencyMs INTEGER, checkedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX PingHistory_uid_checkedAt_idx ON PingHistory(uid, checkedAt);
CREATE INDEX PingHistory_checkedAt_idx ON PingHistory(checkedAt);
CREATE TABLE Passkey (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credentialId TEXT NOT NULL UNIQUE,
      publicKey TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      label TEXT DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    , prfWrapped TEXT);
CREATE TABLE AppToken (
      token TEXT PRIMARY KEY,
      label TEXT DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      lastUsedAt TEXT
    );
CREATE TABLE AppSnapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      payload TEXT NOT NULL DEFAULT '{}'
    );

-- 后加列（已存在会失败，安装时忽略错误）
ALTER TABLE AppConfig ADD COLUMN themeAccent TEXT;
ALTER TABLE AppConfig ADD COLUMN uiPrefs TEXT DEFAULT '{}';
ALTER TABLE AppConfig ADD COLUMN tokenEpoch INTEGER DEFAULT 0;
ALTER TABLE Member ADD COLUMN name TEXT DEFAULT '';
