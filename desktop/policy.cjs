'use strict';
const APP_ORIGIN = 'https://vigilant.local';
const EXTERNAL = new Set(['dexscreener.com','bscscan.com','testnet.bscscan.com','arbiscan.io','solscan.io','github.com']);
function isLocal(value) { try { return new URL(value).origin === APP_ORIGIN; } catch { return false; } }
function safeExternal(value) { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && EXTERNAL.has(u.hostname); } catch { return false; } }
function safeAsset(root,pathname) {
  const path = require('node:path');
  let decoded; try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const full = path.resolve(root,'.'+(decoded==='/'?'/index.html':decoded)),relative = path.relative(root,full);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? full : null;
}
module.exports = {APP_ORIGIN,isLocal,safeExternal,safeAsset};
