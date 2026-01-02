// server.js
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as DiscordStrategy } from 'passport-discord';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import pg from 'pg';
import pgSession from 'connect-pg-simple';
import Database from 'better-sqlite3';
import axios from 'axios'; // 追加
import { diffChars } from 'diff';
import SQLiteStore from 'connect-sqlite3';
const SQLiteStoreSession = SQLiteStore(session);

const { Pool } = pg;
const PgSession = pgSession(session);

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_USERS = ['1047797479665578014']; // Admin Discord IDs

// --- PostgreSQL Setup ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', () => {
  // 初回接続時などのログ
});
pool.on('error', (err) => {
  console.error('❌ PostgreSQL error:', err);
});

const dataDir = path.join(process.cwd(), 'data');
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const processStubs = (content, isAdmin = false) => {
  return content.replace(/\[stab:(.+?)\]/g, (match, stubType) => {
    // 削除候補は管理者のみ
    if (stubType === '削除候補' && !isAdmin) {
      return '';
    }
    return renderStub(stubType);
  });
};

// --- Markdown renderer & sanitizer ---
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const renderStub = (stubType) => {
  const stubs = {
    '書きかけ': {
      title: 'この記事は書きかけです。',
      content: 'ご存じの情報があれば加筆をお願いします。',
      color: '#f39c12'
    },
    'うんこ': {
      title: 'うんこ！w',
      content: 'うんちうんちうんち！うんこ！ww',
      color: '#8b4513'
    },
    '誤情報': {
      title: 'この記事は正しくない情報が含まれているかもしれません',
      content: 'でもRec Wikiでは誰もそんなこと気にしないし、処罰の対象にもなりません。',
      color: '#e74c3c'
    },
    '削除候補': {
      title: 'この記事は削除候補としてリストされています',
      content: 'Rec Wikiコミュニティガイドラインに違反している可能性が高いため、近日削除されるかもしれません。\nまた違反が見つからなかった場合このスタブは削除されます。',
      color: '#c0392b'
    }
  };

  const stub = stubs[stubType];
  if (!stub) return '';

  return `<div class="stub-notice" style="background-color: ${stub.color}20; border-left: 4px solid ${stub.color}; padding: 16px; margin: 20px 0; border-radius: 8px;">
    <h3 style="margin: 0 0 8px 0; color: ${stub.color};">⚠️ ${stub.title}</h3>
    <p style="margin: 0; white-space: pre-line;">${stub.content}</p>
  </div>`;
};

const sanitize = (html) =>
  sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']),
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height']
    },
    allowedSchemes: ['http', 'https', 'mailto']
  });

// --- Database Initialization ---
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Session Table (for connect-pg-simple)
    await client.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL
      )
      WITH (OIDS=FALSE);
      ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT VALID;
    `).catch(() => {}); // Already exists ignore

    // Application Tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS allowed_users (
        user_id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS wikis (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        address TEXT UNIQUE NOT NULL,
        favicon TEXT,
        owner_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        views INTEGER DEFAULT 0,
        deleted_at TIMESTAMP,
        description TEXT,
        is_public INTEGER DEFAULT 1,
        updated_at TIMESTAMP,
        page_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS pages (
        id SERIAL PRIMARY KEY,
        wiki_id INTEGER NOT NULL REFERENCES wikis(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW(),
        deleted_at TIMESTAMP,
        view_count INTEGER DEFAULT 0,
        is_locked INTEGER DEFAULT 0,
        tags TEXT,
        UNIQUE(wiki_id, name)
      );
      CREATE TABLE IF NOT EXISTS revisions (
        id SERIAL PRIMARY KEY,
        page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        editor_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        display_name TEXT,
        bio TEXT,
        email TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        last_wiki_created_at TIMESTAMP,
        avatar_url TEXT,
        last_login_at TIMESTAMP,
        failed_login_attempts INTEGER DEFAULT 0,
        account_locked_until TIMESTAMP,
        total_edits INTEGER DEFAULT 0,
        email_notifications INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS user_badges (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
        badge_name TEXT NOT NULL,
        badge_color TEXT NOT NULL DEFAULT '#3498db',
        granted_by TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS user_warnings (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        issued_by TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS user_suspensions (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL, -- 'temporary' or 'permanent'
        reason TEXT NOT NULL,
        issued_by TEXT NOT NULL,
        expires_at TIMESTAMP, -- NULL for permanent
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS user_languages (
        user_id TEXT PRIMARY KEY,
        language TEXT DEFAULT 'ja'
      );

      /* Permission related tables */
      CREATE TABLE IF NOT EXISTS wiki_settings (
        wiki_id INTEGER PRIMARY KEY REFERENCES wikis(id) ON DELETE CASCADE,
        mode TEXT DEFAULT 'loggedin', /* 'anyone' | 'loggedin' | 'invite' */
        is_searchable INTEGER DEFAULT 1,
        allow_anonymous_edit INTEGER DEFAULT 0,
        max_page_size INTEGER DEFAULT 1048576,
        theme TEXT DEFAULT 'light'
      );
      CREATE TABLE IF NOT EXISTS wiki_permissions (
        wiki_id INTEGER NOT NULL REFERENCES wikis(id) ON DELETE CASCADE,
        editor_id TEXT NOT NULL,
        role TEXT DEFAULT 'editor',
        PRIMARY KEY(wiki_id, editor_id)
      );
      CREATE TABLE IF NOT EXISTS wiki_invites (
        id SERIAL PRIMARY KEY,
        wiki_id INTEGER NOT NULL REFERENCES wikis(id) ON DELETE CASCADE,
        invited_tag TEXT, /* e.g. Username#1234 */
        invited_id TEXT, /* filled when accepted: discord id */
        role TEXT DEFAULT 'editor',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Add Indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pages_wiki_id ON pages(wiki_id);
      CREATE INDEX IF NOT EXISTS idx_pages_name ON pages(name);
      CREATE INDEX IF NOT EXISTS idx_wikis_owner_id ON wikis(owner_id);
      CREATE INDEX IF NOT EXISTS idx_wikis_address ON wikis(address);
      CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
      CREATE INDEX IF NOT EXISTS idx_revisions_page_id ON revisions(page_id);
    `);

    // Seed Allowed User
    await client.query( 
      'INSERT INTO allowed_users(user_id) VALUES ($1) ON CONFLICT DO NOTHING',
      ['1047797479665578014']
    );

    // Migrations / Schema Updates (Add missing columns if table exists)
    // Note: PostgreSQL `ADD COLUMN IF NOT EXISTS` requires version 9.6+
    const addColumn = async (table, column, type) => {
      try {
        await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
      } catch (e) {
        // console.log(`Migration note: ${e.message}`);
      }
    };

    await addColumn('wiki_settings', 'is_searchable', 'INTEGER DEFAULT 1');
    await addColumn('user_profiles', 'last_wiki_created_at', 'TIMESTAMP');
    await addColumn('user_profiles', 'avatar_url', 'TEXT');
    await addColumn('user_profiles', 'bio', 'TEXT');
    await addColumn('user_profiles', 'last_login_at', 'TIMESTAMP');
    await addColumn('wiki_settings', 'allow_anonymous_edit', 'INTEGER DEFAULT 0');
    await addColumn('wiki_settings', 'max_page_size', 'INTEGER DEFAULT 1048576');
    await addColumn('wiki_settings', 'theme', "TEXT DEFAULT 'light'");
    await addColumn('pages', 'view_count', 'INTEGER DEFAULT 0');
    await addColumn('pages', 'is_locked', 'INTEGER DEFAULT 0');
    await addColumn('pages', 'tags', 'TEXT');
    await addColumn('wikis', 'description', 'TEXT');
    await addColumn('wikis', 'is_public', 'INTEGER DEFAULT 1');
    await addColumn('wikis', 'updated_at', 'TIMESTAMP');
    await addColumn('user_profiles', 'failed_login_attempts', 'INTEGER DEFAULT 0');
    await addColumn('user_profiles', 'account_locked_until', 'TIMESTAMP');
    await addColumn('user_profiles', 'total_edits', 'INTEGER DEFAULT 0');
    await addColumn('wikis', 'page_count', 'INTEGER DEFAULT 0');
    await addColumn('user_profiles', 'email_notifications', 'INTEGER DEFAULT 1');

    await client.query('COMMIT');
    console.log("✅ Database initialized & migrated!");
  } catch (error) {
    await client.query('ROLLBACK');
    console.error("❌ Database initialization failed:", error);
  } finally {
    client.release();
  }
}

// i18n Dictionary
const i18n = {
  ja: {
    home: 'ホーム',
    login: 'Discordでログイン',
    logout: 'ログアウト',
    createWiki: 'Wiki作成',
    profile: 'プロフィール',
    dashboard: 'ダッシュボード',
    admin: '管理者',
    settings: '設定',
    edit: '編集',
    view: '表示',
    delete: '削除',
    save: '保存',
    cancel: 'キャンセル',
    confirm: '確認',
    warning: '警告',
    suspend: '停止',
    ban: '永久停止',
    wikiNotFound: 'Wikiが見つかりません',
    pageNotFound: 'ページが見つかりません',
    noPermission: '権限がありません',
    popularWikis: '人気のWiki',
    recentEdits: '最近の編集',
    stats: '統計',
    users: 'ユーザー',
    pages: 'ページ',
    wikis: 'Wiki一覧'
  },
  en: {
    home: 'Home',
    login: 'Login with Discord',
    logout: 'Logout',
    createWiki: 'Create Wiki',
    profile: 'Profile',
    dashboard: 'Dashboard',
    admin: 'Admin',
    settings: 'Settings',
    edit: 'Edit',
    view: 'View',
    delete: 'Delete',
    save: 'Save',
    cancel: 'Cancel',
    confirm: 'Confirm',
    warning: 'Warning',
    suspend: 'Suspend',
    ban: 'Ban',
    wikiNotFound: 'Wiki not found',
    pageNotFound: 'Page not found',
    noPermission: 'No permission',
    popularWikis: 'Popular Wikis',
    recentEdits: 'Recent Edits',
    stats: 'Stats',
    users: 'Users',
    pages: 'Pages',
    wikis: 'Wikis'
  }
};

// --- Passport / Discord OAuth2 ---
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));
passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_REDIRECT_URI || `${BASE_URL}/auth/discord/callback`,
    scope: ['identify', 'email']
}, async (accessToken, refreshToken, profile, done) => {
    try {
      const now = new Date();
      await pool.query(`
        INSERT INTO user_profiles (user_id, display_name, email, created_at, last_login_at) 
        VALUES ($1, $2, $3, $4, $5) 
        ON CONFLICT(user_id) DO UPDATE SET 
        display_name = EXCLUDED.display_name, 
        email = EXCLUDED.email,
        last_login_at = EXCLUDED.last_login_at
      `, [profile.id, profile.username, profile.email, now, now]);
      done(null, profile);
    } catch (err) {
      done(err, null);
    }
}));

// --- Middlewares ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  store: new PgSession({
    pool: pool,
    tableName: 'session'
  }),
  secret: process.env.SESSION_SECRET || 'change_me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    secure: process.env.NODE_ENV === 'production'
  }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use('/public', express.static(path.join(process.cwd(), 'public')));
app.use('/uploads', express.static(uploadDir));
app.set('trust proxy', 1);

// Middleware to get user's language preference and suspension status
app.use(async (req, res, next) => {
    req.isSuspended = false;
    if (req.isAuthenticated()) {
        try {
          const langRes = await pool.query('SELECT language FROM user_languages WHERE user_id = $1', [req.user.id]);
          req.userLang = langRes.rows[0] ? langRes.rows[0].language : 'ja';

          const suspRes = await pool.query('SELECT * FROM user_suspensions WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1', [req.user.id]);
          if (suspRes.rows.length > 0) {
              req.isSuspended = true;
              req.suspensionDetails = suspRes.rows[0];
          }
        } catch (e) {
          console.error("Middleware DB error", e);
          req.userLang = 'ja';
        }
    } else {
        req.userLang = req.session.language || 'ja';
    }
    next();
});

// --- Helpers ---
const createSuspensionBlock = (req) => {
    const lang = req.userLang;
    const body = `<div class="card"><p class="danger">❌ ${lang === 'ja' ? 'アカウントが停止されているため、この操作は実行できません。' : 'Your account is suspended, and you cannot perform this action.'}</p><a class="btn" href="/">戻る</a></div>`;
    return renderLayout('Suspended', body, null, lang, req);
};

const ensureAuth = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  return res.redirect('/auth/discord');
};

const ensureAdmin = (req, res, next) => {
  if (!req.isAuthenticated() || !ADMIN_USERS.includes(req.user.id)) {
    return res.status(403).send(renderLayout('Forbidden', `
      <div class="card">
        <p class="danger">管理者権限が必要です</p>
        <a class="btn" href="/">戻る</a>
      </div>
    `, null, 'ja', req));
  }
  next();
};

const ensureCanCreate = (req, res, next) => {
  if (!req.isAuthenticated()) return res.redirect('/auth/discord');
  if (req.isSuspended) return res.status(403).send(createSuspensionBlock(req));
  next();
};

const ensureCanAdministerWiki = async (req, res, next) => {
  if (!req.isAuthenticated()) return res.redirect('/auth/discord');
  if (req.isSuspended) return res.status(403).send(createSuspensionBlock(req));
  
  const address = req.params.address;
  const wiki = await wikiByAddress(address);
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">❌ Wiki not found.</p></div>`, null, req.userLang, req));

  const permRes = await pool.query('SELECT role FROM wiki_permissions WHERE wiki_id = $1 AND editor_id = $2', [wiki.id, req.user.id]);
  const perm = permRes.rows[0];
  
  if (wiki.owner_id === req.user.id || (perm && perm.role === 'admin') || ADMIN_USERS.includes(req.user.id)) {
    return next();
  }

  return res.status(403).send(renderLayout('Forbidden', `<div class="card"><p class="danger">❌ ${req.userLang === 'ja' ? 'Wikiの管理権限がありません' : 'You do not have administrative permissions for this wiki'}.</p><a class="btn" href="/${wiki.address}">${req.userLang === 'ja' ? '戻る' : 'Back'}</a></div>`, null, req.userLang, req));
};

// Async DB Helpers
const wikiByAddress = async (address) => {
  const res = await pool.query('SELECT * FROM wikis WHERE address = $1 AND deleted_at IS NULL', [address]);
  return res.rows[0];
};

const pageByWikiAndName = async (wikiId, name) => {
  const res = await pool.query('SELECT * FROM pages WHERE wiki_id = $1 AND name = $2 AND deleted_at IS NULL', [wikiId, name]);
  return res.rows[0];
};

const getText = (key, lang = 'ja') => i18n[lang] && i18n[lang][key] ? i18n[lang][key] : i18n.ja[key] || key;

const renderLayout = (title, body, favicon = null, lang = 'ja', req = null) => {
    let suspensionBanner = '';
    if (req && req.isSuspended) {
        const details = req.suspensionDetails;
        suspensionBanner = `
          <div class="card" style="background-color: var(--danger-color); color: white; margin-bottom: 20px; border-color: var(--danger-color);">
            <h3 style="margin-top:0; color: white;">${lang === 'ja' ? 'アカウントが停止されています' : 'Account Suspended'}</h3>
            <p style="margin-bottom:0;">${lang === 'ja' ? '理由' : 'Reason'}: ${details.reason}</p>
          </div>
        `;
    }
    // 変更: デフォルトファビコンの設定
    const faviconTag = favicon ? `<link rel="icon" href="${favicon}">` : '<link rel="icon" href="/public/Icon.png">';

    return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <title>${title || 'Rec Wiki'}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta property="og:site_name" content="Rec Wiki">
  <meta property="og:title" content="${title || 'Rec Wiki'}">
  <meta property="og:description" content="Rec Wikiで作成されたWikiページ">
  <meta property="og:image" content="/public/RecWikiThumbnation.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="theme-color" content="#3498db">
  <meta name="twitter:card" content="summary_large_image">
  ${faviconTag}

    <link rel="manifest" href="/public/manifest.json">
  <meta name="theme-color" content="#3498db">
  <script>
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/public/service-worker.js');
    }
  </script>
  
  <style>
    :root {
      --bg-primary: #ffffff;
      --bg-secondary: #f8f9fa;
      --text-primary: #2c3e50;
      --text-secondary: #6c757d;
      --border-color: #dee2e6;
      --button-bg: #ffffff;
      --button-hover: #e9ecef;
      --card-bg: #ffffff;
      --code-bg: #f8f9fa;
      --accent-color: #3498db;
      --success-color: #27ae60;
      --danger-color: #e74c3c;
      --warning-color: #f39c12;
    }
    [data-theme="dark"] {
      --bg-primary: #1a1a1a;
      --bg-secondary: #2d2d2d;
      --text-primary: #e1e1e1;
      --text-secondary: #a0a0a0;
      --border-color: #404040;
      --button-bg: #2d2d2d;
      --button-hover: #404040;
      --card-bg: #2d2d2d;
      --code-bg: #1e1e1e;
      --accent-color: #5dade2;
      --success-color: #58d68d;
      --danger-color: #ec7063;
      --warning-color: #f7dc6f;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px 20px 80px 20px;
      line-height: 1.7;
      background-color: var(--bg-primary);
      color: var(--text-primary);
      transition: background-color 0.3s ease, color 0.3s ease;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 32px;
      padding-bottom: 16px;
      border-bottom: 2px solid var(--border-color);
      flex-wrap: wrap;
    }
    .header-left, .header-right { 
      display: flex; 
      align-items: center; 
      gap: 12px; 
      flex: 1;
    }
    .desktop-header-items {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header-center { 
      flex: 1; 
      text-align: center; 
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .header-right {
      justify-content: flex-end;
    }
    .header-left a, .header-left button { transition: all 0.2s ease; }
    .desktop-only { display: inline-flex; }
    .mobile-only { display: none; }
    .diff-added { background-color: rgba(46, 160, 67, 0.2); text-decoration: none; }
    .diff-removed { background-color: rgba(248, 81, 73, 0.2); text-decoration: line-through; }
    
    /* Button Styles */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border-radius: 8px;
      border: 1px solid var(--border-color);
      text-decoration: none;
      background-color: var(--button-bg);
      color: var(--text-primary);
      transition: all 0.2s ease;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
    }
    .btn:hover { background-color: var(--button-hover); transform: translateY(-1px); }
    .btn.primary { background-color: var(--accent-color); color: white; border-color: var(--accent-color); }
    .btn.primary:hover { background-color: #2980b9; border-color: #2980b9; }
    .btn.success { background-color: var(--success-color); color: white; border-color: var(--success-color); }
    .btn.danger { background-color: var(--danger-color); color: white; border-color: var(--danger-color); }
    .btn.warning { background-color: var(--warning-color); color: white; border-color: var(--warning-color); }
    .btn.disabled, a.btn.disabled {
      pointer-events: none;
      cursor: not-allowed;
      opacity: 0.6;
    }
    
    /* Language Dropdown Styles */
    .language-dropdown {
      position: relative;
      display: inline-block;
    }
    .language-button {
      background: none;
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 10px 16px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-size: 14px;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .language-button:hover { background-color: var(--button-hover); }
    .language-menu {
      position: absolute;
      top: 100%;
      right: 0;
      margin-top: 4px;
      min-width: 140px;
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      display: none;
      z-index: 1000;
      overflow: hidden;
    }
    .language-menu.show { display: block; }
    .language-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      color: var(--text-primary);
      text-decoration: none;
      font-size: 14px;
      transition: background-color 0.2s ease;
      border: none;
      background: none;
      width: 100%;
      cursor: pointer;
    }
    .language-option:hover { background-color: var(--button-hover); }
    .language-option.active { background-color: var(--accent-color); color: white; }
    
    /* Mobile Drawer Styles */
    .mobile-drawer-button {
      background: none;
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      padding: 8px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-size: 18px;
    }
    .mobile-drawer-button:hover { background-color: var(--button-hover); }
    .mobile-drawer {
      position: fixed;
      top: 0;
      left: -300px;
      width: 300px;
      height: 100vh;
      background: var(--card-bg);
      border-right: 1px solid var(--border-color);
      z-index: 2000;
      transition: left 0.3s ease;
      box-shadow: 2px 0 12px rgba(0,0,0,0.1);
    }
    .mobile-drawer.open { left: 0; }
    .drawer-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0,0,0,0.5);
      z-index: 1999;
      display: none;
    }
    .drawer-overlay.show { display: block; }
    .drawer-header {
      padding: 20px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .drawer-close {
      background: none;
      border: none;
      font-size: 24px;
      cursor: pointer;
      color: var(--text-primary);
    }
    .drawer-content {
      padding: 20px;
    }
    .drawer-section {
      margin-bottom: 24px;
    }
    .drawer-section h3 {
      margin: 0 0 12px 0;
      font-size: 16px;
      color: var(--text-primary);
    }
    .drawer-option {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      margin: 8px 0;
      border-radius: 8px;
      color: var(--text-primary);
      text-decoration: none;
      background-color: var(--button-bg);
      border: 1px solid var(--border-color);
      transition: all 0.2s ease;
      cursor: pointer;
      font-size: 14px;
    }
    .drawer-option:hover { background-color: var(--button-hover); }
    .drawer-option.active { background-color: var(--accent-color); color: white; border-color: var(--accent-color); }

    .bottom-nav {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: var(--card-bg);
      border-top: 1px solid var(--border-color);
      display: none;
      justify-content: space-around;
      align-items: center;
      padding: 12px 0;
      z-index: 1000;
    }
    .nav-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-decoration: none;
      color: var(--text-secondary);
      font-size: 12px;
      transition: color 0.2s ease;
    }
    .nav-item:hover, .nav-item.active { color: var(--accent-color); }
    .nav-icon { font-size: 20px; margin-bottom: 4px; }
    input, textarea, select { width: 100%; padding: 12px; border: 1px solid var(--border-color); border-radius: 8px; background-color: var(--card-bg); color: var(--text-primary); font-size: 14px; transition: border-color 0.2s ease; }
    input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent-color); box-shadow: 0 0 0 3px rgba(52, 152, 219, 0.1); }
    textarea { min-height: 400px; font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace; resize: vertical; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 6px; font-weight: 500; color: var(--text-primary); }
    .form-help { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }
    .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; }
    .muted { color: var(--text-secondary); }
    .card { border: 1px solid var(--border-color); padding: 24px; border-radius: 12px; background-color: var(--card-bg); box-shadow: 0 2px 4px rgba(0,0,0,0.05); margin-bottom: 20px; }
    .chip { padding: 6px 12px; border: 1px solid var(--border-color); border-radius: 20px; background-color: var(--button-bg); color: var(--text-primary); text-decoration: none; font-size: 13px; transition: all 0.2s ease; }
    .chip:hover { background-color: var(--button-hover); transform: translateY(-1px); }
    .upload-zone { border: 2px dashed var(--border-color); border-radius: 8px; padding: 20px; text-align: center; background-color: var(--bg-secondary); transition: all 0.2s ease; cursor: pointer; margin-bottom: 16px; }
    .preview-images { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; margin-top: 16px; }
    .preview-item { position: relative; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; background-color: var(--card-bg); }
    .preview-item img { width: 100%; height: 100px; object-fit: cover; }
    pre { background-color: var(--code-bg); padding: 16px; border-radius: 8px; overflow-x: auto; border: 1px solid var(--border-color); }
    code { background-color: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 13px; border: 1px solid var(--border-color); }
    .content img { max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .breadcrumb { margin-bottom: 20px; font-size: 14px; }
    .breadcrumb a { color: var(--accent-color); text-decoration: none; }
    .fade-in { animation: fadeIn 0.3s ease-in; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    
    @media (max-width: 768px) {
      body { padding: 16px 16px 80px 16px; }
      header {
        flex-direction: row;
        justify-content: space-between;
      }
      .header-center { order: 0; text-align: center; }
      .header-left { order: -1; }
      .header-right { order: 1; }
      .desktop-only { display: none; }
      .mobile-only { display: inline-flex; }
      .row { grid-template-columns: 1fr; }
      .card { padding: 16px; }
      .bottom-nav { display: flex; }
    }
  </style>
</head>
<body data-theme="light" class="fade-in">
${suspensionBanner}
<header>
  <div class="header-left">
    <a class="btn desktop-only" href="/">🏠 ${getText('home', lang)}</a>
    <div class="mobile-only">
      <button class="mobile-drawer-button" onclick="toggleMobileDrawer()">☰</button>
    </div>
  </div>
  <div class="header-center">
    <h1 style="margin: 0; font-size: 1.5rem;"><a href="/" style="text-decoration: none; color: var(--text-primary);">Rec Wiki</a></h1>
  </div>
  <div class="header-right">
    <div class="desktop-only desktop-header-items">
      <div class="language-dropdown">
        <button class="language-button" onclick="toggleLanguageDropdown()">
          ${lang === 'ja' ? '🇯🇵 日本語' : '🇺🇸 English'} ▼
        </button>
        <div class="language-menu" id="language-menu">
          <a href="/lang/ja" class="language-option ${lang === 'ja' ? 'active' : ''}">
            🇯🇵 日本語
          </a>
          <a href="/lang/en" class="language-option ${lang === 'en' ? 'active' : ''}">
            🇺🇸 English
          </a>
        </div>
      </div>
      <button class="btn" onclick="toggleTheme()" title="テーマ切替">🌓</button>
    </div>
    <div id="auth"></div>
  </div>
</header>

<div class="drawer-overlay" id="drawer-overlay" onclick="closeMobileDrawer()"></div>
<div class="mobile-drawer" id="mobile-drawer">
  <div class="drawer-header">
    <h3 style="margin: 0;">設定</h3>
    <button class="drawer-close" onclick="closeMobileDrawer()">×</button>
  </div>
  <div class="drawer-content">
    <div class="drawer-section">
      <h3>🌓 テーマ</h3>
      <button class="drawer-option" onclick="toggleTheme(); closeMobileDrawer();">
        <span id="theme-icon">🌙</span> 
        <span id="theme-text">ダークモード</span>
      </button>
    </div>
    <div class="drawer-section">
      <h3>🌐 言語</h3>
      <a href="/lang/ja" class="drawer-option ${lang === 'ja' ? 'active' : ''}">
        🇯🇵 日本語
      </a>
      <a href="/lang/en" class="drawer-option ${lang === 'en' ? 'active' : ''}">
        🇺🇸 English
      </a>
    </div>
  </div>
</div>

${body}
<nav class="bottom-nav">
  <a href="/" class="nav-item">
    <div class="nav-icon">🏠</div>
    <div>${getText('home', lang)}</div>
  </a>
  <a href="/create-wiki" class="nav-item">
    <div class="nav-icon">➕</div>
    <div>${getText('createWiki', lang)}</div>
  </a>
  <a href="/dashboard" class="nav-item">
    <div class="nav-icon">📊</div>
    <div>${getText('dashboard', lang)}</div>
  </a>
  <a href="/admin" class="nav-item" id="admin-nav" style="display: none;">
    <div class="nav-icon">⚙️</div>
    <div>${getText('admin', lang)}</div>
  </a>
  <a href="/profile" class="nav-item">
    <div class="nav-icon">👤</div>
    <div>${getText('profile', lang)}</div>
  </a>
</nav>

<script>
// Theme Toggle Function
function toggleTheme() {
  const body = document.body;
  const newTheme = body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  body.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
  updateThemeText();
}

function updateThemeText() {
  const isDark = document.body.getAttribute('data-theme') === 'dark';
  const themeIcon = document.getElementById('theme-icon');
  const themeText = document.getElementById('theme-text');
  if (themeIcon && themeText) {
    themeIcon.textContent = isDark ? '☀️' : '🌙';
    themeText.textContent = isDark ? 'ライトモード' : 'ダークモード';
  }
}

// Language Dropdown Functions
function toggleLanguageDropdown() {
  const menu = document.getElementById('language-menu');
  menu.classList.toggle('show');
}

// Mobile Drawer Functions
function toggleMobileDrawer() {
  const drawer = document.getElementById('mobile-drawer');
  const overlay = document.getElementById('drawer-overlay');
  drawer.classList.toggle('open');
  overlay.classList.toggle('show');
}

function closeMobileDrawer() {
  const drawer = document.getElementById('mobile-drawer');
  const overlay = document.getElementById('drawer-overlay');
  drawer.classList.remove('open');
  overlay.classList.remove('show');
}

// Initialize theme
document.body.setAttribute('data-theme', localStorage.getItem('theme') || 'light');
updateThemeText();

// Close dropdowns when clicking outside
document.addEventListener('click', function(event) {
  const languageDropdown = document.querySelector('.language-dropdown');
  const languageMenu = document.getElementById('language-menu');
  const userMenu = document.querySelector('.user-menu');
  const userDropdown = document.getElementById('user-dropdown');
  
  if (languageMenu && languageDropdown && !languageDropdown.contains(event.target)) {
    languageMenu.classList.remove('show');
  }
  
  if (userDropdown && userMenu && !userMenu.contains(event.target)) {
    userDropdown.style.display = 'none';
  }
});

// Authentication handling
fetch('/api/me').then(r => r.json()).then(me => {
  const el = document.getElementById('auth');
  const adminNav = document.getElementById('admin-nav');
  if (!el) return;
  if (me.loggedIn) {
    el.innerHTML = \`
      <div class="user-menu" style="position: relative;">
        <img src="\${me.avatar}" alt="avatar" style="width:36px;height:36px;border-radius:50%;cursor:pointer;" onclick="toggleUserMenu()">
        <div id="user-dropdown" style="position: absolute; top: 100%; right: 0; margin-top: 8px; min-width: 220px; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); display: none; z-index: 1000;">
          <div style="padding: 12px; border-bottom: 1px solid var(--border-color);">
            <div style="font-weight: 500; color: var(--text-primary);">\${me.username}</div>
            <div style="font-size: 12px; color: var(--text-secondary);">#\${me.discriminator}</div>
            <div style="font-size: 12px; color: var(--text-secondary);">ID: \${me.id}</div>
          </div>
          <div style="padding: 8px;">
            <a href="/user/\${me.id}" class="dropdown-item" style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; color: var(--text-primary); text-decoration: none; border-radius: 4px; transition: background-color 0.2s ease;">👤 ${getText('profile', '${lang}')}</a>
            <a href="/dashboard" class="dropdown-item" style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; color: var(--text-primary); text-decoration: none; border-radius: 4px; transition: background-color 0.2s ease;">📊 ${getText('dashboard', '${lang}')}</a>
            \${me.isAdmin ? '<a href="/admin" class="dropdown-item" style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; color: var(--text-primary); text-decoration: none; border-radius: 4px; transition: background-color 0.2s ease;">⚙️ ${getText('admin', '${lang}')}</a>' : ''}
            <a href="/logout" class="dropdown-item" style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; color: var(--text-primary); text-decoration: none; border-radius: 4px; transition: background-color 0.2s ease;">🚪 ${getText('logout', '${lang}')}</a>
          </div>
        </div>
      </div>
    \`;
    
    // Add hover effect to dropdown items
    setTimeout(() => {
      const dropdownItems = document.querySelectorAll('.dropdown-item');
      dropdownItems.forEach(item => {
        item.addEventListener('mouseenter', () => {
          item.style.backgroundColor = 'var(--button-hover)';
        });
        item.addEventListener('mouseleave', () => {
          item.style.backgroundColor = 'transparent';
        });
      });
    }, 100);
    
    if (me.isAdmin && adminNav) {
      adminNav.style.display = 'flex';
    }
  } else {
    // Desktop: Discord icon with text, Mobile: Discord icon only
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
      el.innerHTML = '<a class="btn primary" href="/auth/discord" title="Discordでログイン"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419-.0190 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1568 2.4189Z"/></svg></a>';
    } else {
      el.innerHTML = '<a class="btn primary" href="/auth/discord"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="margin-right: 8px;"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419-.0190 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1568 2.4189Z"/></svg>${getText('login', lang)}</a>';
    }
  }
}).catch(err => console.warn('Authentication status check failed:', err));

function toggleUserMenu() {
  const dropdown = document.getElementById('user-dropdown');
  if (!dropdown) return;
  dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
}
</script>
</body>
</html>`;
}

// --- Language Routes ---
// --- 修正後のコード ---
app.get('/lang/:lang', async (req, res) => { // asyncを追加
  const { lang } = req.params;
  if (!['ja', 'en'].includes(lang)) {
    return res.redirect('/');
  }
  
  if (req.isAuthenticated()) {
    // PostgreSQL用のUPSERT構文に変更
    await pool.query(`
      INSERT INTO user_languages(user_id, language) 
      VALUES ($1, $2) 
      ON CONFLICT(user_id) DO UPDATE SET language = $2
    `, [req.user.id, lang]);
  } else {
    req.session.language = lang;
  }
  
  res.redirect(req.get('Referer') || '/');
});

// --- Auth routes ---
app.get('/auth/discord', passport.authenticate('discord'));
app.get(
  '/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => res.redirect('/create-wiki')
);
app.get('/logout', (req, res) => {
  req.logout(() => {});
  res.redirect('/');
});

// --- API: current user ---
app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ loggedIn: false });
  const { id, username, discriminator, avatar } = req.user;
  const ext = avatar && avatar.startsWith('a_') ? 'gif' : 'png';
  const avatarUrl = avatar
    ? `https://cdn.discordapp.com/avatars/${id}/${avatar}.${ext}?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(discriminator) % 5}.png`;
  const isAdmin = ADMIN_USERS.includes(id);
  res.json({ loggedIn: true, id, username, discriminator, avatar: avatarUrl, isAdmin });
});

// --- Admin Dashboard ---
app.get('/admin', ensureAdmin, (req, res) => {
  const lang = req.userLang;
  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > ⚙️ ${getText('admin', lang)}</div>
    <h1>⚙️ ${getText('admin', lang)} Dashboard</h1>
    
    <div class="row">
      <div class="card">
        <h3>📊 ${getText('stats', lang)}</h3>
        <div id="admin-stats">Loading...</div>
      </div>
      <div class="card">
        <h3>👥 ${getText('users', lang)} Management</h3>
        <div class="form-group">
          <label>Search User by Discord ID</label>
          <input type="text" id="user-search" placeholder="Enter Discord ID">
          <button class="btn primary" onclick="searchUser()">Search</button>
        </div>
        <div id="user-search-results"></div>
      </div>
    </div>

    <div class="row">
      <div class="card">
        <h3>📚 ${getText('wikis', lang)} Management</h3>
        <div id="wiki-management">Loading...</div>
      </div>
      <div class="card">
        <h3>📝 Recent Activities</h3>
        <div id="recent-activities">Loading...</div>
      </div>
    </div>

    <script>
      // Load admin stats
      fetch('/api/admin/stats').then(r => r.json()).then(data => {
        document.getElementById('admin-stats').innerHTML = \`
          <p><strong>Total Wikis:</strong> \${data.totalWikis}</p>
          <p><strong>Total Pages:</strong> \${data.totalPages}</p>
          <p><strong>Total Users:</strong> \${data.totalUsers}</p>
          <p><strong>Total Revisions:</strong> \${data.totalRevisions}</p>
        \`;
      });

      // Load wikis for management
      fetch('/api/admin/wikis').then(r => r.json()).then(data => {
        const html = data.wikis.map(w => \`
          <div class="card" style="margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <h4 style="margin: 0;">\${w.name}</h4>
              <div>
                <button class="btn" onclick="editWiki('\${w.id}')">Edit</button>
                <button class="btn danger" onclick="deleteWiki('\${w.id}', '\${w.name}')">Delete</button>
              </div>
            </div>
            <p class="muted">Address: \${w.address} • Views: \${w.views} • Pages: \${w.pageCount}</p>
            <p class="muted">Owner: \${w.owner_id} • Created: \${new Date(w.created_at).toLocaleDateString()}</p>
          </div>
        \`).join('');
        document.getElementById('wiki-management').innerHTML = html || '<p class="muted">No wikis found.</p>';
      });

      // Load recent activities
      fetch('/api/admin/activities').then(r => r.json()).then(data => {
        const html = data.activities.map(a => \`
          <div style="margin-bottom: 12px; padding: 12px; background: var(--bg-secondary); border-radius: 8px;">
            <strong>\${a.type}</strong> by \${a.user_id}
            <div class="muted">\${a.details} • \${new Date(a.created_at).toLocaleString()}</div>
          </div>
        \`).join('');
        document.getElementById('recent-activities').innerHTML = html || '<p class="muted">No recent activities.</p>';
      });

      function searchUser() {
        const userId = document.getElementById('user-search').value.trim();
        if (!userId) return;
        
        fetch(\`/api/admin/user/\${userId}\`).then(r => r.json()).then(data => {
          const resultsEl = document.getElementById('user-search-results');
          if (data.error) {
            resultsEl.innerHTML = \`<p class="danger">\${data.error}</p>\`;
            return;
          }
          
          let userInfoHtml = \`<h4>User ID: \${userId}</h4>\`;
          if (data.discordUser) {
            const { global_name, username, id, email } = data.discordUser;
            userInfoHtml = \`
              <h4>\${global_name || username} (\${username || 'N/A'})</h4>
              <p class="muted">\${id}</p>
              \${email ? \`<p class="muted">Email: \${email}</p>\` : ''}
            \`;
          }

          const warnings = data.warnings.map(w => \`
            <div>⚠️ \${w.reason} (by \${w.issued_by}, \${new Date(w.created_at).toLocaleDateString()})</div>
          \`).join('') || '<div class="muted">No warnings</div>';
          
          const suspension = data.suspension ? \`
            <div class="danger">🚫 \${data.suspension.type === 'permanent' ? 'Permanently banned' : 'Temporarily suspended'}: \${data.suspension.reason}</div>
          \` : '<div class="muted">Not suspended</div>';
          
          resultsEl.innerHTML = \`
            <div class="card">
              \${userInfoHtml}
              <hr style="margin: 16px 0;">
              <p><strong>Warnings:</strong></p>
              \${warnings}
              <p><strong>Suspension Status:</strong></p>
              \${suspension}
              <div style="margin-top: 16px; display: flex; gap: 8px;">
                <button class="btn warning" onclick="warnUser('\${userId}')">警告</button>
                <button class="btn danger" onclick="suspendUser('\${userId}')">一時停止</button>
                <button class="btn danger" onclick="banUser('\${userId}')">永久停止</button>
              </div>
            </div>
          \`;
        });
      }

      function warnUser(userId) {
        const reason = prompt('Warning reason:');
        if (!reason) return;
        
        fetch(\`/api/admin/user/\${userId}/warn\`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ reason })
        }).then(r => r.json()).then(data => {
          if (data.success) {
            alert('Warning issued');
            searchUser();
          } else {
            alert('Failed to issue warning');
          }
        });
      }

      function suspendUser(userId) {
        const reason = prompt('Suspension reason:');
        if (!reason) return;
        const days = prompt('Days to suspend (leave empty for permanent):');
        
        fetch(\`/api/admin/user/\${userId}/suspend\`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ reason, days: days ? parseInt(days) : null })
        }).then(r => r.json()).then(data => {
          if (data.success) {
            alert('User suspended');
            searchUser();
          } else {
            alert('Failed to suspend user');
          }
        });
      }

      function banUser(userId) {
        const reason = prompt('Ban reason:');
        if (!reason) return;
        if (!confirm('Permanently ban this user?')) return;
        
        fetch(\`/api/admin/user/\${userId}/ban\`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ reason })
        }).then(r => r.json()).then(data => {
          if (data.success) {
            alert('User banned permanently');
            searchUser();
          } else {
            alert('Failed to ban user');
          }
        });
      }

      function editWiki(wikiId) {
        // Implement wiki editing modal or redirect
        alert('Wiki editing feature - to be implemented');
      }

      function deleteWiki(wikiId, wikiName) {
        if (!confirm(\`Delete wiki "\${wikiName}"? This cannot be undone.\`)) return;
        
        fetch(\`/api/admin/wiki/\${wikiId}\`, {
          method: 'DELETE'
        }).then(r => r.json()).then(data => {
          if (data.success) {
            alert('Wiki deleted');
            location.reload();
          } else {
            alert('Failed to delete wiki');
          }
        });
      }
    </script>
  `;
  res.send(renderLayout(`${getText('admin', lang)} Dashboard`, body, null, lang, req));
});

// --- Admin API Routes ---
app.get('/api/admin/stats', ensureAdmin, async (req, res) => {
  const w = await pool.query('SELECT COUNT(*) as count FROM wikis WHERE deleted_at IS NULL');
  const p = await pool.query('SELECT COUNT(*) as count FROM pages WHERE deleted_at IS NULL');
  const u = await pool.query('SELECT COUNT(DISTINCT editor_id) as count FROM revisions');
  const r = await pool.query('SELECT COUNT(*) as count FROM revisions');
  res.json({ 
      totalWikis: parseInt(w.rows[0].count), 
      totalPages: parseInt(p.rows[0].count), 
      totalUsers: parseInt(u.rows[0].count), 
      totalRevisions: parseInt(r.rows[0].count) 
  });
});

app.get('/api/admin/wikis', ensureAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT w.*, COUNT(p.id) as pageCount 
    FROM wikis w 
    LEFT JOIN pages p ON w.id = p.wiki_id AND p.deleted_at IS NULL 
    WHERE w.deleted_at IS NULL 
    GROUP BY w.id 
    ORDER BY w.views DESC, w.created_at DESC
  `);
  res.json({ wikis: result.rows });
});

app.get('/api/admin/activities', ensureAdmin, async (req, res) => { // Added async
  const result = await pool.query(`
    SELECT 'revision' as type, editor_id as user_id, 'Edited page' as details, created_at
    FROM revisions
    ORDER BY created_at DESC
    LIMIT 20
  `);
  
  res.json({ activities: result.rows });
});

app.get('/api/admin/user/:userId', ensureAdmin, async (req, res) => {
  const { userId } = req.params;
  const warnings = await pool.query('SELECT * FROM user_warnings WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  const suspension = await pool.query('SELECT * FROM user_suspensions WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1', [userId]);
  
  let discordUser = { id: userId, username: 'Unknown' };
  try {
      if (process.env.DISCORD_BOT_TOKEN) {
          const dRes = await axios.get(`https://discord.com/api/v10/users/${userId}`, { headers: { 'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}` }});
          discordUser = dRes.data;
      }
  } catch (e) {}

  res.json({ warnings: warnings.rows, suspension: suspension.rows[0], discordUser });
});

app.post('/api/admin/user/:userId/warn', ensureAdmin, async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Reason required' });
  await pool.query('INSERT INTO user_warnings(user_id, reason, issued_by) VALUES ($1,$2,$3)', [userId, reason, req.user.id]);
  res.json({ success: true });
});

app.post('/api/admin/user/:userId/suspend', ensureAdmin, async (req, res) => {
  const { userId } = req.params;
  const { reason, days } = req.body;
  let expiresAt = null;
  let type = 'permanent';
  if (days && days > 0) {
    const d = new Date(); d.setDate(d.getDate() + parseInt(days));
    expiresAt = d;
    type = 'temporary';
  }
  await pool.query('INSERT INTO user_suspensions(user_id, type, reason, issued_by, expires_at) VALUES ($1,$2,$3,$4,$5)', [userId, type, reason, req.user.id, expiresAt]);
  res.json({ success: true });
});

app.post('/api/admin/user/:userId/ban', ensureAdmin, async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body;
  await pool.query('INSERT INTO user_suspensions(user_id, type, reason, issued_by, expires_at) VALUES ($1,$2,$3,$4,NULL)', [userId, 'permanent', reason, req.user.id]);
  res.json({ success: true });
});

app.delete('/api/admin/wiki/:wikiId', ensureAdmin, async (req, res) => {
  const { wikiId } = req.params;
  await pool.query('UPDATE wikis SET deleted_at = NOW() WHERE id = $1', [wikiId]);
  await pool.query('UPDATE pages SET deleted_at = NOW() WHERE wiki_id = $1', [wikiId]);
  res.json({ success: true });
});

// --- API: Image Upload ---
const imageUpload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

app.post('/api/upload-image', ensureAuth, imageUpload.single('image'), (req, res) => {
  if (req.isSuspended) return res.status(403).json({ error: 'Account suspended' });
  if (!req.file) return res.status(400).json({ error: 'No file was uploaded' });
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ filename: req.file.filename, url: fileUrl, size: req.file.size });
});

// --- API: get paginated wikis ---
app.get('/api/wikis', async (req, res) => {
  const skip = parseInt(req.query.skip || '0', 10);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));
  const result = await pool.query(`
    SELECT w.id, w.name, w.address, w.favicon, w.created_at, w.views 
    FROM wikis w
    LEFT JOIN wiki_settings ws ON w.id = ws.wiki_id
    WHERE w.deleted_at IS NULL AND (ws.is_searchable = 1 OR ws.is_searchable IS NULL)
    ORDER BY w.views DESC, w.created_at DESC 
    LIMIT $1 OFFSET $2
  `, [limit, skip]);
  res.json({ wikis: result.rows, count: result.rows.length });
});

// --- Home ---
app.get('/', (req, res) => {
  const lang = req.userLang;
  const isSuspended = !!req.isSuspended;
  const disabledClass = isSuspended ? 'disabled' : '';

  const body = `
    <div class="breadcrumb">🏠 ${getText('home', lang)}</div>

    <div id="guidelines-banner" class="card" style="background-color: var(--accent-color); color: white; margin-bottom: 24px; border-color: var(--accent-color); display: none;">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 16px;">
        <p style="margin: 0;">利用の前に、コミュニティガイドラインとプライバシーポリシーをご確認ください</p>
        <div style="display: flex; gap: 8px;">
          <a class="btn" href="https://wiki.rec877.com/rules/home" target="_blank" style="background-color: white; color: var(--accent-color); border-color: white;">📖 閲覧</a>
          <button class="btn" onclick="dismissGuidelines()" style="background-color: rgba(255,255,255,0.2); color: white; border-color: rgba(255,255,255,0.3);">×</button>
        </div>
      </div>
    </div>

    <div style="text-align: center; margin-bottom: 24px;">
      <h2>Welcome to Rec Wiki</h2>
      <p class="muted">${lang === 'ja' ? 'Discord連携済み & 許可ユーザーのみWikiを新規作成できます。' : 'Only authorized users with linked Discord accounts can create new wikis.'}</p>
      <a class="btn primary ${disabledClass}" href="/create-wiki">🆕 ${getText('createWiki', lang)}</a>
    </div>

    <div class="card">
      <h3>📚 ${getText('popularWikis', lang)}</h3>
      <div id="wiki-list">Loading...</div>
      <div style="text-align:center; margin-top:12px;">
        <button id="load-more" class="btn" style="display:none;">${lang === 'ja' ? 'もっと見る' : 'Load More'}</button>
      </div>
    </div>

    <script>
      // ガイドラインバナーの表示・非表示制御
      if (!localStorage.getItem('guidelines-dismissed')) {
        document.getElementById('guidelines-banner').style.display = 'block';
      }

      function dismissGuidelines() {
        document.getElementById('guidelines-banner').style.display = 'none';
        localStorage.setItem('guidelines-dismissed', 'true');
      }

      let skip = 0;
      const limit = 10;
      const listEl = document.getElementById('wiki-list');
      const loadMoreBtn = document.getElementById('load-more');
      const isSuspended = ${isSuspended};
      const disabledClass = isSuspended ? 'disabled' : '';

      async function loadWikis() {
        loadMoreBtn.disabled = true;
        const res = await fetch('/api/wikis?skip=' + skip + '&limit=' + limit);
        const data = await res.json();
        if (!data.wikis.length && skip === 0) {
          listEl.innerHTML = '<div class="muted">${lang === 'ja' ? 'Wikiがまだありません。' : 'No wikis yet.'}</div>';
          return;
        }
        const html = data.wikis.map(w => \`
          <div class="card" style="margin-bottom:12px;">
            <h3 style="margin-top:0;">
              \${w.favicon ? '<img src="'+w.favicon+'" width="20" height="20" style="vertical-align: middle; margin-right: 8px;">' : '📚'}
              <a href="/\${w.address}" style="color: var(--accent-color); text-decoration: none;">\${w.name}</a>
            </h3>
            <p class="muted">Address: <span class="mono">\${w.address}</span></p>
            <p class="muted">${lang === 'ja' ? '閲覧数' : 'Views'}: <strong>\${w.views || 0}</strong> • ${lang === 'ja' ? '作成日' : 'Created'}: <span class="mono">\${new Date(w.created_at).toLocaleDateString('${lang === 'ja' ? 'ja-JP' : 'en-US'}')}</span></p>
            <div style="margin-top: 8px;">
              <a class="btn" href="/\${w.address}">📖 ${getText('view', lang)}</a>
              <a class="btn \${disabledClass}" href="/\${w.address}-edit">✏️ ${getText('edit', lang)}</a>
            </div>
          </div>
        \`).join('');
        if (skip === 0) listEl.innerHTML = html;
        else listEl.insertAdjacentHTML('beforeend', html);

        if (data.wikis.length === limit) {
          loadMoreBtn.style.display = 'inline-flex';
        } else {
          loadMoreBtn.style.display = 'none';
        }
        skip += data.wikis.length;
        loadMoreBtn.disabled = false;
      }

      loadMoreBtn.addEventListener('click', loadWikis);
      loadWikis();
    </script>
  `;
  res.send(renderLayout('Rec Wiki', body, null, lang, req));
});

// --- User Dashboard ---
app.get('/dashboard', ensureAuth, async (req, res) => { // Added async
  const lang = req.userLang;
  const userId = req.user.id;
  const isSuspended = !!req.isSuspended;
  const disabledClass = isSuspended ? 'disabled' : '';
  
  // Use pool.query, change ? to $1, and access .rows
  const ownedRes = await pool.query('SELECT * FROM wikis WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC', [userId]);
  const ownedWikis = ownedRes.rows;
  
  // Change ? to $1, $2
  const editableRes = await pool.query(`
    SELECT w.* FROM wikis w 
    JOIN wiki_permissions wp ON w.id = wp.wiki_id 
    WHERE wp.editor_id = $1 AND w.owner_id != $2 AND w.deleted_at IS NULL
  `, [userId, userId]);
  const editableWikis = editableRes.rows;
  
  const recentRes = await pool.query(`
    SELECT p.name as page_name, w.name as wiki_name, w.address as wiki_address, r.created_at
    FROM revisions r
    JOIN pages p ON r.page_id = p.id 
    JOIN wikis w ON p.wiki_id = w.id
    WHERE r.editor_id = $1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY r.created_at DESC LIMIT 10
  `, [userId]);
  const recentEdits = recentRes.rows;

  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > 📊 ${getText('dashboard', lang)}</div>
    <h1>📊 ${getText('dashboard', lang)}</h1>
    
    <div class="row">
      <div class="card">
        <h3>📚 ${lang === 'ja' ? '所有Wiki' : 'Owned Wikis'}</h3>
        ${ownedWikis.length ? ownedWikis.map(w => `
          <div style="margin-bottom: 12px; padding: 12px; background: var(--bg-secondary); border-radius: 8px;">
            <h4 style="margin: 0;"><a href="/${w.address}">${w.name}</a></h4>
            <p class="muted">${w.address} • ${lang === 'ja' ? '閲覧数' : 'Views'}: ${w.views || 0}</p>
            <a class="btn ${disabledClass}" href="/${w.address}-edit">${getText('edit', lang)}</a>
          </div>
        `).join('') : `<p class="muted">${lang === 'ja' ? '所有Wikiがありません。' : 'No owned wikis.'}</p>`}
      </div>
      
      <div class="card">
        <h3>✏️ ${lang === 'ja' ? '編集可能Wiki' : 'Editable Wikis'}</h3>
        ${editableWikis.length ? editableWikis.map(w => `
          <div style="margin-bottom: 12px; padding: 12px; background: var(--bg-secondary); border-radius: 8px;">
            <h4 style="margin: 0;"><a href="/${w.address}">${w.name}</a></h4>
            <p class="muted">${w.address}</p>
            <a class="btn ${disabledClass}" href="/${w.address}-edit">${getText('edit', lang)}</a>
          </div>
        `).join('') : `<p class="muted">${lang === 'ja' ? '編集可能Wikiがありません。' : 'No editable wikis.'}</p>`}
      </div>
    </div>

    <div class="card">
      <h3>📝 ${getText('recentEdits', lang)}</h3>
      ${recentEdits.length ? recentEdits.map(e => `
        <div style="margin-bottom: 12px; padding: 12px; background: var(--bg-secondary); border-radius: 8px;">
          <a href="/${e.wiki_address}/${encodeURIComponent(e.page_name)}">📄 ${e.page_name}</a> 
          ${lang === 'ja' ? 'in' : 'in'} 
          <a href="/${e.wiki_address}">📚 ${e.wiki_name}</a>
          <div class="muted">${new Date(e.created_at).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US')}</div>
        </div>
      `).join('') : `<p class="muted">${lang === 'ja' ? '最近の編集がありません。' : 'No recent edits.'}</p>`}
    </div>
  `;
  
  res.send(renderLayout(`${getText('dashboard', lang)}`, body, null, lang, req));
});

// --- Profile redirect ---
app.get('/profile', ensureAuth, (req, res) => {
  res.redirect(`/user/${req.user.id}`);
});

// --- Create wiki form ---
app.get('/create-wiki', ensureCanCreate, (req, res) => {
  const lang = req.userLang;
  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > 🆕 ${getText('createWiki', lang)}</div>
    <h1>🆕 ${lang === 'ja' ? '新しいWikiを作成' : 'Create a New Wiki'}</h1>
    <p class="muted">${lang === 'ja' ? 'Wiki名とアドレスは一意である必要があります。' : 'The Wiki Name and Address must be unique.'}</p>
    <form action="/create-wiki" method="post" enctype="multipart/form-data" class="card">
      <div class="form-group">
        <label>📝 ${lang === 'ja' ? 'Wiki名（表示名、一意）' : 'Wiki Name (Display Name, Unique)'}</label>
        <input name="name" required placeholder="e.g., MyTeamWiki" maxlength="100">
        <div class="form-help">${lang === 'ja' ? '他のユーザーに表示される名前' : 'The name displayed to other users'}</div>
      </div>
      <div class="form-group">
        <label>🔗 ${lang === 'ja' ? 'アドレス（URL用、一意、英数字とハイフンのみ）' : 'Address (For URL, Unique, Alphanumeric & Hyphens only)'}</label>
        <input name="address" required pattern="[a-zA-Z0-9-]{2,64}" placeholder="e.g., my-team-wiki" maxlength="64">
        <div class="form-help mono">${lang === 'ja' ? '結果URL' : 'Resulting URL'}: ${BASE_URL}/<span id="preview">my-team-wiki</span></div>
      </div>
      <div class="row">
        <div class="form-group">
          <label>🌐 ${lang === 'ja' ? 'ファビコンURL（オプション）' : 'Favicon URL (Optional)'}</label>
          <input name="faviconUrl" placeholder="https://.../favicon.png">
          <div class="form-help">${lang === 'ja' ? '外部URLからファビコンを設定' : 'Set a favicon from an external URL'}</div>
        </div>
        <div class="form-group">
          <label>📎 ${lang === 'ja' ? 'ファビコンアップロード（オプション）' : 'Upload Favicon (Optional)'}</label>
          <input type="file" name="faviconFile" accept="image/*">
          <div class="form-help">${lang === 'ja' ? 'ローカルファイルをアップロード' : 'Upload a local file'}</div>
        </div>
      </div>
      <div class="form-group">
        <label>🔒 ${lang === 'ja' ? '初期公開設定' : 'Initial Access Setting'}</label>
        <select name="initialMode">
          <option value="loggedin" selected>${lang === 'ja' ? 'ログインユーザーのみ（デフォルト）' : 'Logged-in users only (Default)'}</option>
          <option value="anyone">${lang === 'ja' ? '誰でも（公開編集）' : 'Anyone (Public editing)'}</option>
          <option value="invite">${lang === 'ja' ? '招待のみ（オーナーが招待）' : 'Invite only (Owner invites)'}</option>
        </select>
        <div class="form-help">${lang === 'ja' ? '後から変更できます。' : 'Can be changed later.'}</div>
      </div>

      <div class="form-group">
        <div class="cf-turnstile" data-sitekey="${process.env.TURNSTILE_SITE_KEY || '1x00000000000000000000AA'}"></div>
      </div>

      <button class="btn success" type="submit">🚀 ${lang === 'ja' ? '作成' : 'Create'}</button>
    </form>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
    <script>
      document.querySelector('input[name="address"]').addEventListener('input', (e) => {
        document.getElementById('preview').textContent = e.target.value || 'my-team-wiki';
      });
    </script>
  `;
  res.send(renderLayout(`${getText('createWiki', lang)}`, body, null, lang, req));
});

// --- Create wiki handler ---
const upload = multer({ dest: uploadDir });
// 変更: Cloudflare Turnstileとレートリミットを導入
// 変更: Cloudflare Turnstileとレートリミットを導入（一時的にレートリミットは無効化）
app.post('/create-wiki', ensureCanCreate, upload.single('faviconFile'), async (req, res) => {
  const lang = req.userLang;

  // 1. レートリミットチェック (5分に1回) - 一時的に無効化
  // TODO: user_profiles テーブルに last_wiki_created_at カラムを追加してから有効化
  /*
  const userProfile = db.prepare('SELECT last_wiki_created_at FROM user_profiles WHERE user_id = ?').get(req.user.id);
  if (userProfile && userProfile.last_wiki_created_at) {
    const lastCreation = new Date(userProfile.last_wiki_created_at).getTime();
    const fiveMinutes = 5 * 60 * 1000;
    if (Date.now() - lastCreation < fiveMinutes) {
      return res.status(429).send(renderLayout('Error', `<div class="card"><p class="danger">❌ ${lang === 'ja' ? 'Wikiの作成は5分に1回までです。しばらく待ってから再度お試しください。' : 'You can only create a wiki once every 5 minutes. Please try again later.'}</p><a class="btn" href="/create-wiki">🔙 ${lang === 'ja' ? '戻る' : 'Back'}</a></div>`, null, lang, req));
    }
  }
  */

  // 2. Cloudflare Turnstile 認証
  try {
    const token = req.body['cf-turnstile-response'];
    const ip = req.headers['cf-connecting-ip'] || req.ip;

    const formData = new URLSearchParams();
    formData.append('secret', process.env.TURNSTILE_SECRET_KEY);
    formData.append('response', token);
    formData.append('remoteip', ip);

    const result = await axios.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', formData);
    if (!result.data.success) {
      return res.status(403).send(renderLayout('Error', `<div class="card"><p class="danger">❌ ${lang === 'ja' ? '認証に失敗しました。ページを更新してもう一度お試しください。' : 'Authentication failed. Please refresh the page and try again.'}</p></div>`, null, lang, req));
    }
  } catch (error) {
    console.error('Turnstile verification request failed:', error.message);
    return res.status(500).send(renderLayout('Error', `<div class="card"><p class="danger">❌ ${lang === 'ja' ? '認証サーバーでエラーが発生しました。' : 'An error occurred with the authentication server.'}</p></div>`, null, lang, req));
  }
  
  // 3. 既存のWiki作成処理
  const { name, address, faviconUrl, initialMode } = req.body;
  const slug = (address || '').trim();
  const wname = (name || '').trim();

  if (!/^[a-zA-Z0-9-]{2,64}$/.test(slug)) {
    return res.status(400).send(renderLayout('Error', `<div class="card"><p class="danger">❌ ${lang === 'ja' ? '無効なアドレス形式です。2-64文字の英数字とハイフンを使用してください。' : 'Invalid address format. Please use 2-64 alphanumeric characters and hyphens.'}</p><a class="btn" href="/create-wiki">🔙 ${lang === 'ja' ? '戻る' : 'Back'}</a></div>`, null, lang, req));
  }
  if (!wname) {
    return res.status(400).send(renderLayout('Error', `<div class="card"><p class="danger">❌ ${lang === 'ja' ? 'Wiki名は必須です。' : 'Wiki name is required.'}</p><a class="btn" href="/create-wiki">🔙 ${lang === 'ja' ? '戻る' : 'Back'}</a></div>`, null, lang, req));
  }

  const existsRes = await pool.query('SELECT 1 FROM wikis WHERE name = $1 OR address = $2', [wname, slug]);
  if (existsRes.rows.length > 0) {
    return res.status(409).send(renderLayout('Duplicate', `<div class="card"><p class="danger">❌ ${lang === 'ja' ? 'Wiki名またはアドレスが既に使用されています。' : 'The Wiki Name or Address is already in use.'}</p><a class="btn" href="/create-wiki">🔙 ${lang === 'ja' ? '戻る' : 'Back'}</a></div>`, null, lang, req));
  }

  let faviconPath = (faviconUrl && /^https?:\/\//.test(faviconUrl)) ? faviconUrl.trim() : null;
  if (req.file) {
    faviconPath = `/uploads/${req.file.filename}`;
  }

  const now = new Date().toISOString();

  try {
    await pool.query('BEGIN'); // トランザクション開始

    // Wiki作成 (RETURNING id でIDを取得)
    const wikiRes = await pool.query(
      'INSERT INTO wikis(name, address, favicon, owner_id, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id', 
      [wname, slug, faviconPath, req.user.id, now]
    );
    const wikiId = wikiRes.rows[0].id;

    const welcomeText = lang === 'ja' ? 
      `# ${wname}\n\n🎉 このWikiへようこそ！\n\n## はじめに\nこのページを編集してWikiを構築しましょう。\n\n## 機能\n- 📝 Markdownでページ作成\n- 🖼️ 画像アップロード対応\n- 🌓 ダークテーマ切替\n- 📱 レスポンシブデザイン\n- 📚 改訂履歴` :
      `# ${wname}\n\n🎉 Welcome to this Wiki!\n\n## Getting Started\nEdit this page to start building your wiki.\n\n## Features\n- 📝 Create pages with Markdown\n- 🖼️ Image upload support\n- 🌓 Dark theme toggle\n- 📱 Responsive design\n- 📚 Revision history`;

    // ホームページ作成
    await pool.query(
      'INSERT INTO pages(wiki_id, name, content, updated_at) VALUES ($1, $2, $3, $4)',
      [wikiId, 'home', welcomeText, now]
    );

    // 設定保存
    const mode = ['anyone', 'loggedin', 'invite'].includes(initialMode) ? initialMode : 'loggedin';
    await pool.query(
      'INSERT INTO wiki_settings(wiki_id, mode) VALUES ($1, $2)',
      [wikiId, mode]
    );

    // 権限設定
    await pool.query(
      'INSERT INTO wiki_permissions(wiki_id, editor_id, role) VALUES ($1, $2, $3)',
      [wikiId, req.user.id, 'admin']
    );

    await pool.query('COMMIT'); // コミット
    res.redirect(`/${slug}-edit`);

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).send("Database Error");
  }
});

// Helper: check if user can edit wiki
// --- 修正後のコード ---
const ensureCanEdit = async (req, res, next) => { // asyncを追加
  if (!req.isAuthenticated()) return res.redirect('/auth/discord');
  if (req.isSuspended) return res.status(403).send(createSuspensionBlock(req));
  const address = req.params.address;
  const wiki = await wikiByAddress(address); // awaitが必要
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">❌ ${req.userLang === 'ja' ? 'Wikiが見つかりません' : 'Wiki not found'}.</p></div>`, null, req.userLang, req));

  // owner -> allowed
  if (wiki.owner_id === req.user.id) return next();
  
  // admin -> allowed
  if (ADMIN_USERS.includes(req.user.id)) return next();

  // explicit permission
  const permRes = await pool.query('SELECT * FROM wiki_permissions WHERE wiki_id = $1 AND editor_id = $2', [wiki.id, req.user.id]);
  if (permRes.rows.length > 0) return next();

  // check wiki_settings
  const settingRes = await pool.query('SELECT mode FROM wiki_settings WHERE wiki_id = $1', [wiki.id]);
  const setting = settingRes.rows[0];
  const mode = setting ? setting.mode : 'loggedin';

  if (mode === 'anyone') return next();
  if (mode === 'loggedin') return next(); 
  
  return res.status(403).send(renderLayout('Forbidden', `<div class="card"><p class="danger">❌ ${req.userLang === 'ja' ? '編集権限がありません' : 'No edit permission'}.</p><a class="btn" href="/${wiki.address}">${req.userLang === 'ja' ? '戻る' : 'Back'}</a></div>`, null, req.userLang, req));
};

// --- Edit dashboard ---
app.get('/:address-edit', ensureCanEdit, async (req, res) => { // asyncを追加
  const lang = req.userLang;
  const wiki = await wikiByAddress(req.params.address); // await
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">❌ ${getText('wikiNotFound', lang)}.</p><a class="btn" href="/">🏠 ${getText('home', lang)}</a></div>`, null, lang, req));

  // pages
  const pagesRes = await pool.query('SELECT name FROM pages WHERE wiki_id = $1 AND deleted_at IS NULL ORDER BY name ASC', [wiki.id]);
  const pages = pagesRes.rows;
  const allPages = pages.map(p => `<a class="chip" href="/${wiki.address}/${encodeURIComponent(p.name)}/edit">📄 ${p.name}</a>`).join('');
  
  const settingsRes = await pool.query('SELECT mode, is_searchable FROM wiki_settings WHERE wiki_id = $1', [wiki.id]);
  const settings = settingsRes.rows[0] || { mode: 'loggedin', is_searchable: 1 };
  
  const permsRes = await pool.query('SELECT editor_id, role FROM wiki_permissions WHERE wiki_id = $1', [wiki.id]);
  const permsHtml = permsRes.rows.map(p => `<div><strong>${p.editor_id}</strong> — <span class="muted">${p.role}</span></div>`).join('') || `<div class="muted">${lang === 'ja' ? '明示的な編集者なし' : 'No explicit editors'}</div>`;
  
  const invitesRes = await pool.query('SELECT id, invited_tag, invited_id, role, created_at FROM wiki_invites WHERE wiki_id = $1 ORDER BY created_at DESC', [wiki.id]);
  const invitesHtml = invitesRes.rows.map(i => `<div><strong>${i.invited_tag || (i.invited_id || '—')}</strong> — <span class="muted">${i.role}</span> <small class="muted">(${new Date(i.created_at).toLocaleString()})</small></div>`).join('') || `<div class="muted">${lang === 'ja' ? '保留中の招待なし' : 'No pending invites'}</div>`;
  
  // 変更: ユーザーが管理者かWikiオーナーかを確認
  const isOwner = wiki.owner_id === req.user.id;
  const isAdmin = ADMIN_USERS.includes(req.user.id);
  const canChangeAdvancedSettings = isOwner || isAdmin;

  // 変更: 管理者とオーナーのみに表示する設定HTMLを生成
  let advancedSettingsHtml = '';
  if (canChangeAdvancedSettings) {
      advancedSettingsHtml = `
        <hr style="margin:16px 0;">
        <h3>🔍 ${lang === 'ja' ? '検索掲載' : 'Search Indexing'}</h3>
        <div class="form-group">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                <input type="checkbox" name="is_searchable" ${settings.is_searchable ? 'checked' : ''} form="perm-form">
                <span>${lang === 'ja' ? '検索エンジンやWiki一覧に掲載する' : 'Allow listing in search engines and wiki lists'}</span>
            </label>
            <div class="form-help">${lang === 'ja' ? 'オフにすると、このWikiがポータルの一覧などに表示されにくくなります。' : 'Turning this off will make this wiki less visible in public lists.'}</div>
        </div>
      `;
  }
  
  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > <a href="/${wiki.address}">📚 ${wiki.name}</a> > ✏️ ${getText('edit', lang)} Dashboard</div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 16px;">
      <h1>✏️ ${wiki.name} Dashboard</h1>
      <a class="btn primary" href="/${wiki.address}">👁️ ${getText('view', lang)} Wiki</a>
    </div>
    <div class="row">
      <div class="card">
        <h2>📄 ${getText('pages', lang)} (${pages.length})</h2>
        <div class="list" style="margin-bottom: 20px;">${allPages || `<span class="muted">${lang === 'ja' ? 'ページがまだありません' : 'No pages yet'}.</span>`}</div>
        <form onsubmit="event.preventDefault(); location.href='/${wiki.address}/'+encodeURIComponent(this.page.value)+'/edit'">
          <div class="form-group">
            <label>📝 ${lang === 'ja' ? '新規または既存のページ名' : 'New or Existing Page Name'}</label>
            <input name="page" required placeholder="e.g., getting-started" maxlength="100">
            <div class="form-help">${lang === 'ja' ? '英数字、ハイフン、アンダースコアが推奨されます。' : 'Alphanumeric, hyphens, and underscores are recommended.'}</div>
          </div>
          <button class="btn success" type="submit">🚀 ${lang === 'ja' ? 'エディターを開く' : 'Open Editor'}</button>
        </form>
      </div>

      <div class="card">
        <h2>📊 Wiki ${lang === 'ja' ? '情報' : 'Info'}</h2>
        <p><strong>📝 ${lang === 'ja' ? 'アドレス' : 'Address'}:</strong> <span class="mono">${wiki.address}</span></p>
        <p><strong>🔗 URL:</strong> <a href="${BASE_URL}/${wiki.address}" target="_blank" class="mono">${BASE_URL}/${wiki.address}</a></p>
        <p><strong>📅 ${lang === 'ja' ? '作成日' : 'Created'}:</strong> ${new Date(wiki.created_at).toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-US')}</p>
        <p><strong>👁️ ${lang === 'ja' ? '閲覧数' : 'Views'}:</strong> ${wiki.views || 0}</p>
        <p><strong>📄 ${getText('pages', lang)}:</strong> ${pages.length}</p>

        <hr style="margin:16px 0;">

        <h3>🌐 Favicon</h3>
        <form action="/${wiki.address}/favicon" method="post" enctype="multipart/form-data">
          <div class="form-group">
            <label>Favicon URL</label>
            <input type="text" name="faviconUrl" placeholder="https://.../favicon.png">
          </div>
          <div class="form-group">
            <label>${lang === 'ja' ? 'ファビコンアップロード' : 'Upload Favicon'}</label>
            <input type="file" name="faviconFile" accept="image/*">
          </div>
          <button class="btn" type="submit">${lang === 'ja' ? '更新' : 'Update'}</button>
        </form>

        <hr style="margin:16px 0;">
        <h3>🔒 ${lang === 'ja' ? '権限設定' : 'Permission Settings'}</h3>
        <form id="perm-form" action="/${wiki.address}/settings" method="post">
          <div class="form-group">
            <label>${lang === 'ja' ? '公開モード' : 'Access Mode'}</label>
            <select name="mode">
              <option value="anyone" ${settings.mode === 'anyone' ? 'selected' : ''}>${lang === 'ja' ? '誰でも（公開編集）' : 'Anyone (Public editing)'}</option>
              <option value="loggedin" ${settings.mode === 'loggedin' ? 'selected' : ''}>${lang === 'ja' ? 'ログインユーザー（デフォルト）' : 'Logged-in users (Default)'}</option>
              <option value="invite" ${settings.mode === 'invite' ? 'selected' : ''}>${lang === 'ja' ? '招待のみ' : 'Invite only'}</option>
            </select>
            <div class="form-help">${lang === 'ja' ? 'ここでモードを切り替えられます。招待モードでは下の招待機能を使ってください。' : 'You can switch modes here. For invite mode, use the invite function below.'}</div>
          </div>
          
          ${advancedSettingsHtml}

          <button class="btn" type="submit">${getText('save', lang)}</button>
        </form>
      </div>
    </div>

    <div class="row">
      <div class="card">
        <h3>👥 ${lang === 'ja' ? '編集者リスト' : 'Editors List'}</h3>
        ${permsHtml}
        <div style="margin-top:12px;">
          <form id="add-perm" onsubmit="event.preventDefault(); addPermission();">
            <div class="form-group">
              <label>Discord ID${lang === 'ja' ? '（直接指定して付与）' : ' (Direct assignment)'}</label>
              <input name="editor_id" placeholder="123456789012345678">
            </div>
            <div class="form-group">
              <label>${lang === 'ja' ? '役割' : 'Role'}</label>
              <input name="role" placeholder="editor / admin">
            </div>
            <button class="btn" type="submit">${lang === 'ja' ? '追加' : 'Add'}</button>
          </form>
        </div>
      </div>

      <div class="card">
        <h3>✉️ ${lang === 'ja' ? '招待 (Username#1234で招待)' : 'Invites (Invite by Username#1234)'}</h3>
        ${invitesHtml}
        <form id="invite-form" onsubmit="event.preventDefault(); sendInvite();">
          <div class="form-group">
            <label>Discord Tag (${lang === 'ja' ? '例' : 'e.g.'}: Banana#1234)</label>
            <input name="invited_tag" placeholder="Username#1234">
          </div>
          <div class="form-group">
            <label>${lang === 'ja' ? '役割' : 'Role'}</label>
            <input name="role" placeholder="editor">
          </div>
          <button class="btn" type="submit">${lang === 'ja' ? '招待を作成' : 'Create Invite'}</button>
        </form>
        <p class="muted" style="margin-top:8px;">${lang === 'ja' ? '相手がDiscordでログインすると、受諾できるUIが表示されます（受諾すると権限リストに自動追加）。' : 'When the recipient logs in with Discord, they will see a UI to accept the invite (acceptance automatically adds them to the permissions list).'}</p>
      </div>
    </div>

    <script>
      async function addPermission() {
        const form = document.getElementById('add-perm');
        const editor_id = form.editor_id.value.trim();
        const role = form.role.value.trim() || 'editor';
        if (!editor_id) return alert('${lang === 'ja' ? 'Discord IDを入力してください' : 'Please enter Discord ID'}');
        const res = await fetch('/${wiki.address}/permissions', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ editor_id, role })});
        if (res.ok) location.reload();
        else alert('Failed to add permission');
      }

      async function sendInvite() {
        const form = document.getElementById('invite-form');
        const invited_tag = form.invited_tag.value.trim();
        const role = form.role.value.trim() || 'editor';
        if (!invited_tag) return alert('${lang === 'ja' ? 'Discord Tagを入力してください' : 'Please enter Discord Tag'}');
        const res = await fetch('/${wiki.address}/invite', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ invited_tag, role })});
        if (res.ok) { alert('${lang === 'ja' ? '招待を作成しました' : 'Invite created'}'); location.reload(); }
        else { alert('${lang === 'ja' ? '招待に失敗しました' : 'Invite failed'}'); }
      }
    </script>
  `;
  res.send(renderLayout(`${wiki.name} ${getText('edit', lang)}`, body, wiki.favicon, lang, req));
});

// --- Remaining routes with full implementation ---
app.post('/:address/favicon', ensureCanAdministerWiki, upload.single('faviconFile'), async (req, res) => { // async
  const wiki = await wikiByAddress(req.params.address);
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">❌ Wiki not found.</p></div>`, null, req.userLang, req));

  let faviconPath = req.body.faviconUrl || null;
  if (req.file) faviconPath = `/uploads/${req.file.filename}`;
  await pool.query('UPDATE wikis SET favicon = $1 WHERE id = $2', [faviconPath, wiki.id]); // $1, $2
  res.redirect(`/${wiki.address}-edit`);
});

app.post('/:address/settings', ensureCanAdministerWiki, async (req, res) => { // async
  const wiki = await wikiByAddress(req.params.address);
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">❌ Wiki not found.</p></div>`, null, req.userLang, req));
  
  const mode = ['anyone', 'loggedin', 'invite'].includes(req.body.mode) ? req.body.mode : 'loggedin';
  const isSearchable = req.body.is_searchable === 'on' ? 1 : 0;
  const isOwner = wiki.owner_id === req.user.id;
  const isAdmin = ADMIN_USERS.includes(req.user.id);

  if (isOwner || isAdmin) {
    // ON CONFLICT 構文
    await pool.query(`
      INSERT INTO wiki_settings (wiki_id, mode, is_searchable) 
      VALUES ($1, $2, $3) 
      ON CONFLICT(wiki_id) DO UPDATE SET 
        mode = excluded.mode, 
        is_searchable = excluded.is_searchable
    `, [wiki.id, mode, isSearchable]);
  } else {
    await pool.query('UPDATE wiki_settings SET mode = $1 WHERE wiki_id = $2', [mode, wiki.id]);
  }
  res.redirect(`/${wiki.address}-edit`);
});

app.post('/:address/permissions', ensureCanAdministerWiki, async (req, res) => { // async
  const wiki = await wikiByAddress(req.params.address);
  if (!wiki) return res.status(404).json({ error: 'not found' });
  const { editor_id, role } = req.body;
  if (!editor_id) return res.status(400).json({ error: 'missing editor_id' });
  
  // INSERT OR REPLACE -> INSERT ... ON CONFLICT
  await pool.query(`
    INSERT INTO wiki_permissions(wiki_id, editor_id, role) 
    VALUES ($1, $2, $3)
    ON CONFLICT(wiki_id, editor_id) DO UPDATE SET role = $3
  `, [wiki.id, editor_id, role || 'editor']);
  res.json({ success: true });
});

app.post('/:address/invite', ensureCanAdministerWiki, async (req, res) => { // async
  const wiki = await wikiByAddress(req.params.address);
  if (!wiki) return res.status(404).json({ error: 'not found' });
  const { invited_tag, role } = req.body;
  if (!invited_tag) return res.status(400).json({ error: 'missing invited_tag' });
  const now = new Date().toISOString();
  await pool.query('INSERT INTO wiki_invites(wiki_id, invited_tag, role, created_at) VALUES ($1, $2, $3, $4)', [wiki.id, invited_tag, role || 'editor', now]);
  res.json({ success: true });
});

// --- API: list invites for logged in user ---
app.get('/api/my-invites', ensureAuth, async (req, res) => { // async
  const tag = `${req.user.username}#${req.user.discriminator}`;
  // 配列をawait処理する必要があるためロジック微修正
  const invitesRes = await pool.query('SELECT id, wiki_id, invited_tag, role, created_at FROM wiki_invites WHERE invited_tag = $1 AND invited_id IS NULL', [tag]);
  
  const detailed = [];
  for (const i of invitesRes.rows) {
    const wRes = await pool.query('SELECT id, name, address FROM wikis WHERE id = $1 AND deleted_at IS NULL', [i.wiki_id]);
    const w = wRes.rows[0];
    if (w) {
      detailed.push({ inviteId: i.id, wiki: w, role: i.role, created_at: i.created_at });
    }
  }
  res.json({ invites: detailed });
});

app.post('/invite/:inviteId/accept', ensureAuth, async (req, res) => { // async
  if (req.isSuspended) return res.status(403).json({ error: 'Account suspended' });
  const inviteId = parseInt(req.params.inviteId, 10);
  const inviteRes = await pool.query('SELECT * FROM wiki_invites WHERE id = $1', [inviteId]);
  const invite = inviteRes.rows[0];
  if (!invite) return res.status(404).json({ error: 'invite not found' });

  const tag = `${req.user.username}#${req.user.discriminator}`;
  if (invite.invited_tag !== tag) return res.status(403).json({ error: 'tag mismatch' });

  await pool.query('BEGIN');
  try {
    await pool.query('UPDATE wiki_invites SET invited_id = $1 WHERE id = $2', [req.user.id, inviteId]);
    await pool.query(`
      INSERT INTO wiki_permissions(wiki_id, editor_id, role) 
      VALUES ($1, $2, $3)
      ON CONFLICT(wiki_id, editor_id) DO UPDATE SET role = $3
    `, [invite.wiki_id, req.user.id, invite.role || 'editor']);
    await pool.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await pool.query('ROLLBACK');
    res.status(500).json({ error: 'Database error' });
  }
});

// --- User Profile API and Page ---
app.get('/api/user/:userId', async (req, res) => { // async
  const { userId } = req.params;
  const profileRes = await pool.query('SELECT * FROM user_profiles WHERE user_id = $1', [userId]);
  const badgesRes = await pool.query('SELECT * FROM user_badges WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  const editCountRes = await pool.query('SELECT COUNT(*) as count FROM revisions WHERE editor_id = $1', [userId]);
  const recentEditsRes = await pool.query(`
    SELECT p.name as page_name, w.name as wiki_name, w.address as wiki_address
    FROM revisions r
    JOIN pages p ON r.page_id = p.id 
    JOIN wikis w ON p.wiki_id = w.id
    WHERE r.editor_id = $1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL
    ORDER BY r.created_at DESC LIMIT 5
  `, [userId]);

  res.json({
    profile: profileRes.rows[0] || { user_id: userId, display_name: null, bio: null },
    badges: badgesRes.rows,
    stats: { editCount: parseInt(editCountRes.rows[0].count) },
    recentEdits: recentEditsRes.rows
  });
});

// --- Invites Display for Users ---
app.get('/invites', ensureAuth, (req, res) => {
  const lang = req.userLang;
  const isSuspended = !!req.isSuspended;
  const disabledClass = isSuspended ? 'disabled' : '';
  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > ✉️ ${lang === 'ja' ? '招待' : 'Invites'}</div>
    <h1>✉️ ${lang === 'ja' ? 'あなたへの招待' : 'Your Invites'}</h1>
    
    <div id="invites-container">
      <div class="card">Loading...</div>
    </div>
    
    <script>
      fetch('/api/my-invites').then(r => r.json()).then(data => {
        const container = document.getElementById('invites-container');
        
        if (!data.invites.length) {
          container.innerHTML = '<div class="card"><p class="muted">${lang === 'ja' ? '招待がありません' : 'No pending invites'}.</p></div>';
          return;
        }
        
        const invitesHtml = data.invites.map(invite => \`
          <div class="card">
            <h3>📚 \${invite.wiki.name}</h3>
            <p class="muted">Role: \${invite.role}</p>
            <p class="muted">${lang === 'ja' ? '招待日' : 'Invited'}: \${new Date(invite.created_at).toLocaleDateString('${lang === 'ja' ? 'ja-JP' : 'en-US'}')}</p>
            <div style="margin-top: 16px;">
              <button class="btn success ${disabledClass}" onclick="acceptInvite(\${invite.inviteId})">${lang === 'ja' ? '承認' : 'Accept'}</button>
              <a class="btn" href="/\${invite.wiki.address}">${getText('view', '${lang}')}</a>
            </div>
          </div>
        \`).join('');
        
        container.innerHTML = invitesHtml;
      });
      
      async function acceptInvite(inviteId) {
        if (${isSuspended}) {
            alert('${lang === 'ja' ? 'アカウントが停止されているため、この操作は実行できません。' : 'Your account is suspended, you cannot perform this action.'}');
            return;
        }
        const res = await fetch(\`/invite/\${inviteId}/accept\`, { method: 'POST' });
        if (res.ok) {
          alert('${lang === 'ja' ? '招待を承認しました！' : 'Invite accepted!'}');
          location.reload();
        } else {
          alert('${lang === 'ja' ? '承認に失敗しました' : 'Failed to accept invite'}');
        }
      }
    </script>
  `;
  
  res.send(renderLayout(`${lang === 'ja' ? '招待' : 'Invites'}`, body, null, lang, req));
});


// --- User Profile Page (Moved before generic routes) ---
app.get('/user/:userId', (req, res) => {
  const { userId } = req.params;
  const lang = req.userLang;
  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > 👤 ${lang === 'ja' ? 'ユーザープロフィール' : 'User Profile'}</div>
    <div id="user-profile-container"><div class="card">Loading...</div></div>
    <script>
      fetch('/api/user/${userId}').then(r => r.json()).then(data => {
        const container = document.getElementById('user-profile-container');
        const { profile, badges, stats, recentEdits } = data;
        const displayName = profile.display_name || 'User ' + '${userId}'.slice(-4);
        container.innerHTML = \`
          <div class="card" style="text-align: center;">
            <div style="width: 80px; height: 80px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: inline-flex; align-items: center; justify-content: center; color: white; font-size: 24px; font-weight: bold; margin: 0 auto 16px;">\${displayName.charAt(0).toUpperCase()}</div>
            <h2 style="margin: 0;">\${displayName}</h2>
            <p class="muted mono" style="font-size: 12px;">ID: ${userId}</p>
            \${profile.bio ? \`<p style="font-style: italic; color: var(--text-secondary);">\${profile.bio}</p>\` : ''}
            <div class="list" style="justify-content: center; margin-top: 16px;">
              \${badges.map(b => \`<span class="chip" style="background-color: \${b.badge_color}; color: white; border-color: \${b.badge_color};">🏆 \${b.badge_name}</span>\`).join('')}
            </div>
          </div>
          <div class="row">
            <div class="card"><h3>📊 ${getText('stats', lang)}</h3><p>\${stats.editCount} ${lang === 'ja' ? '編集総数' : 'Total Edits'}</p></div>
            <div class="card"><h3>📝 ${getText('recentEdits', lang)}</h3>
              \${recentEdits.length ? recentEdits.map(e => \`<div><a href="/\${e.wiki_address}/\${encodeURIComponent(e.page_name)}">📄 \${e.page_name}</a> in 📚 \${e.wiki_name}</div>\`).join('') : '<p class="muted">${lang === 'ja' ? '最近の編集なし' : 'No recent edits'}.</p>'}
            </div>
          </div>
        \`;
      }).catch(err => {
        document.getElementById('user-profile-container').innerHTML = \`<div class="card"><p class="danger">Error: ${lang === 'ja' ? 'ユーザープロフィールを読み込めませんでした' : 'Could not load user profile'}.</p></div>\`;
      });
    </script>
  `;
  res.send(renderLayout(`${lang === 'ja' ? 'ユーザープロフィール' : 'User Profile'}`, body, null, lang, req));
});

// --- Page routes ---
app.get('/:address/:page/revisions', ensureAuth, async (req, res) => { // async
  if (req.isSuspended) return res.status(403).send(createSuspensionBlock(req));
  const { address, page } = req.params;
  const lang = req.userLang;
  const wiki = await wikiByAddress(address);
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">❌ ${getText('wikiNotFound', lang)}.</p></div>`, null, lang, req));
  const pg = await pageByWikiAndName(wiki.id, page);
  if (!pg) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">❌ ${getText('pageNotFound', lang)}.</p></div>`, null, lang, req));

  const revsRes = await pool.query(`SELECT id, editor_id, created_at FROM revisions WHERE page_id = $1 ORDER BY id DESC`, [pg.id]);
  const revs = revsRes.rows;
  const rows = revs.map((r, i) => `
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <strong style="color: var(--accent-color);">${lang === 'ja' ? 'リビジョン' : 'Revision'} #${revs.length - i}</strong>
          <span class="muted" style="margin-left: 16px;">by ${r.editor_id}</span>
          <br>
          <span class="mono muted">${new Date(r.created_at).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US')}</span>
        </div>
        <a class="btn" href="/${wiki.address}/${encodeURIComponent(pg.name)}/revision/${r.id}">${getText('view', lang)}</a>
      </div>
    </div>
  `).join('');

  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > <a href="/${wiki.address}">📚 ${wiki.name}</a> > <a href="/${wiki.address}/${encodeURIComponent(pg.name)}">📄 ${pg.name}</a> > 📋 ${lang === 'ja' ? '改訂履歴' : 'Revisions'}</div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 16px;">
      <h1>📋 ${lang === 'ja' ? '改訂履歴' : 'Revisions for'} ${pg.name}</h1>
      <a class="btn" href="/${wiki.address}/${encodeURIComponent(pg.name)}">📄 ${lang === 'ja' ? 'ページに戻る' : 'Back to Page'}</a>
    </div>
    ${rows || `<div class="card"><p class="muted">${lang === 'ja' ? '改訂履歴がまだありません' : 'No revisions yet'}.</p></div>`}
  `;
  res.send(renderLayout(`${wiki.name}/${pg.name} ${lang === 'ja' ? '改訂履歴' : 'Revisions'}`, body, wiki.favicon, lang, req));
});

app.get('/:address/:page/revision/:revId', ensureCanAdministerWiki, async (req, res) => { // async
  const { address, page, revId } = req.params;
  const lang = req.userLang;
  const wiki = await wikiByAddress(address);
  if (!wiki) return res.status(404).send(renderLayout('404', `<p>Wiki not found</p>`, null, lang, req));
  const pg = await pageByWikiAndName(wiki.id, page); // ✅ awaitを追加
  if (!pg) return res.status(404).send(renderLayout('404', `<p>Page not found</p>`, null, lang, req));
  
  const revRes = await pool.query(
  'SELECT * FROM revisions WHERE id = $1 AND page_id = $2',
  [revId, pg.id]
  );
  const revision = revRes.rows[0];
  if (!revision) return res.status(404).send(renderLayout('404', `<p>Revision not found</p>`, null, lang, req));

  const diffResult = diffChars(pg.content, revision.content);
  const diffHtml = diffResult.map(part => {
    const colorClass = part.added ? 'diff-added' : part.removed ? 'diff-removed' : '';
    const text = part.value.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    return `<span class="${colorClass}">${text}</span>`;
  }).join('');
  
  const body = `
    <div class="breadcrumb"><a href="/${wiki.address}/${encodeURIComponent(page)}/revisions">📋 ${lang === 'ja' ? '履歴' : 'History'}</a> > 👁️ ${lang === 'ja' ? 'リビジョン表示' : 'View Revision'}</div>
    <h1>${lang === 'ja' ? 'リビジョン' : 'Revision'} from ${new Date(revision.created_at).toLocaleString()}</h1>
    <p>${lang === 'ja' ? 'このリビジョンにページを巻き戻すことができます。' : 'You can roll back the page to this revision.'}</p>
    
    <form method="post" action="/${wiki.address}/${encodeURIComponent(page)}/revision/${revId}/rollback" onsubmit="return confirm('${lang === 'ja' ? '本当にこのリビジョンに巻き戻しますか？' : 'Are you sure you want to roll back to this revision?'}')">
      <button class="btn danger" type="submit">⏪ ${lang === 'ja' ? 'このバージョンに巻き戻す' : 'Rollback to this Version'}</button>
    </form>

    <div class="card" style="margin-top: 20px;">
      <h2>${lang === 'ja' ? '現在のバージョンとの差分' : 'Difference from Current Version'}</h2>
      <p><span class="diff-added" style="padding: 2px 4px; border-radius: 4px;">${lang === 'ja' ? '追加' : 'Added'}</span> <span class="diff-removed" style="padding: 2px 4px; border-radius: 4px;">${lang === 'ja' ? '削除' : 'Removed'}</span></p>
      <pre style="white-space: pre-wrap; word-wrap: break-word;"><code>${diffHtml}</code></pre>
    </div>

    <div class="card" style="margin-top: 20px;">
      <h2>${lang === 'ja' ? 'リビジョンの全内容' : 'Full Content of Revision'}</h2>
      <pre><code>${revision.content.replace(/</g,'&lt;')}</code></pre>
    </div>
  `;
  res.send(renderLayout('View Revision', body, wiki.favicon, lang, req));
});

app.post('/:address/:page/revision/:revId/rollback', ensureCanAdministerWiki, async (req, res) => { // async
  const { address, page, revId } = req.params;
  const wiki = await wikiByAddress(address);
  if (!wiki) return res.status(404).send('Wiki not found');
  const pg = await pageByWikiAndName(wiki.id, page); // ✅ awaitを追加
  if (!pg) return res.status(404).send('Page not found');

  const revisionRes = await pool.query('SELECT * FROM revisions WHERE id = $1 AND page_id = $2', [revId, pg.id]);
  const revision = revisionRes.rows[0];
  if (!revision) return res.status(404).send('Revision not found');

  const now = new Date().toISOString();
  const rollbackContent = revision.content;

  await pool.query('UPDATE pages SET content = $1, updated_at = $2 WHERE id = $3', [rollbackContent, now, pg.id]);
  await pool.query('INSERT INTO revisions(page_id, content, editor_id, created_at) VALUES ($1, $2, $3, $4)', [pg.id, rollbackContent, req.user.id, now]);

  res.redirect(`/${address}/${encodeURIComponent(page)}`);
});

app.get('/:address/:page/edit', ensureCanEdit, async (req, res) => { // async
  const { address, page } = req.params;
  const lang = req.userLang;
  const wiki = await wikiByAddress(address);
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">❌ ${getText('wikiNotFound', lang)}.</p></div>`, null, lang, req));

  const pg = await pageByWikiAndName(wiki.id, req.params.page); // await
  const content = pg ? (pg.content || '') : '';

  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > <a href="/${wiki.address}">📚 ${wiki.name}</a> > <a href="/${wiki.address}/${encodeURIComponent(page)}">📄 ${page}</a> > ✏️ ${getText('edit', lang)}</div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 16px;">
      <h1>✏️ ${wiki.name} / ${page}</h1>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <a class="btn" href="/${wiki.address}/${encodeURIComponent(page)}">👁️ ${getText('view', lang)} Page</a>
        <a class="btn" href="/${wiki.address}-edit">🏠 Dashboard</a>
      </div>
    </div>
    <form method="post" action="/${wiki.address}/${encodeURIComponent(page)}/edit" class="card">
      <h2>📝 ${getText('edit', lang)} Content</h2>
      <div class="form-group">
        <label>🖼️ ${lang === 'ja' ? '画像アップロード' : 'Image Upload'}</label>
        <div id="upload-zone" class="upload-zone">
          <div>📎 ${lang === 'ja' ? 'ここに画像をドラッグ＆ドロップするか、クリックして選択' : 'Drag & drop images here or click to select'}</div>
          <div class="muted" style="font-size: 12px;">JPG, PNG, GIF, WebP ${lang === 'ja' ? 'サポート（最大10MB）' : 'supported (Max 10MB)'}</div>
          <input type="file" id="image-upload" multiple accept="image/*" style="display: none;">
        </div>
        <div id="preview-images" class="preview-images"></div>
      </div>
      <details style="margin-bottom: 20px; border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; background-color: var(--bg-secondary);">
        <summary style="cursor: pointer; font-weight: 500;">${lang === 'ja' ? 'Markdown記法サンプル' : 'Markdown Cheatsheet'}</summary>
        <pre style="margin-top: 12px; background-color: var(--card-bg);"><code># 見出し1
## 見出し2
### 見出し3
**太字** or __太字__
*斜体* or _斜体_
~~打ち消し線~~
- リスト1
- リスト2
  - 入れ子リスト
1. 番号付きリスト1
2. 番号付きリスト2
> 引用
[リンクのテキスト](https://example.com)
![画像の説明](/uploads/your-image.png)
\`\`\`javascript
// コードブロック
function hello() {
  console.log("Hello, World!");
}
\`\`\`
</code></pre>
      </details>
      <div class="form-group">
        <label>📄 Markdown Content</label>
        <textarea name="content" placeholder="# Start with a heading!">${content.replace(/</g,'&lt;')}</textarea>
        <div class="form-help">${lang === 'ja' ? 'Markdownで記述。保存後にプレビューが利用可能です。' : 'Written in Markdown. Preview is available after saving.'}</div>
      </div>
      <button class="btn success" type="submit">💾 ${getText('save', lang)}</button>
    </form>
    <script>
      function initImageUpload() {
        const uploadZone = document.getElementById('upload-zone');
        const fileInput = document.getElementById('image-upload');
        const previewContainer = document.getElementById('preview-images');
        const textarea = document.querySelector('textarea[name="content"]');
        if (!uploadZone || !fileInput) return;
        
        let uploadedImages = [];
        
        uploadZone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
        uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.style.backgroundColor = 'var(--accent-color)'; uploadZone.style.opacity = '0.1'; });
        uploadZone.addEventListener('dragleave', () => { uploadZone.style.backgroundColor = ''; uploadZone.style.opacity = ''; });
        uploadZone.addEventListener('drop', (e) => { e.preventDefault(); uploadZone.style.backgroundColor = ''; uploadZone.style.opacity = ''; handleFiles(e.dataTransfer.files); });
        
        function handleFiles(files) { Array.from(files).forEach(file => { if (file.type.startsWith('image/')) uploadImage(file); }); }
        
        async function uploadImage(file) {
          const formData = new FormData();
          formData.append('image', file);
          try {
            const response = await fetch('/api/upload-image', { method: 'POST', body: formData });
            if (!response.ok) throw new Error('Upload failed');
            const result = await response.json();
            uploadedImages.push({ url: result.url, originalName: file.name });
            updatePreview();
          } catch (err) { alert('${lang === 'ja' ? '画像アップロードに失敗しました' : 'Image upload failed'}: ' + err.message); }
        }
        
        function updatePreview() {
          previewContainer.innerHTML = uploadedImages.map((img, index) => \`
            <div class="preview-item" style="position: relative;">
              <img src="\${img.url}" alt="\${img.originalName}" style="width: 100%; height: 100px; object-fit: cover; border-radius: 8px;">
              <button type="button" onclick="removeImage(\${index})" style="position: absolute; top: 4px; right: 4px; background: var(--danger-color); color: white; border: none; border-radius: 50%; width: 24px; height: 24px; cursor: pointer;">×</button>
              <div style="padding: 8px; font-size: 12px; text-align: center;">\${img.originalName}</div>
              <button type="button" class="btn" style="margin: 0 8px 8px 8px; font-size: 11px; padding: 4px 8px;" onclick="insertImageMarkdown('\${img.url}', '\${img.originalName}')">${lang === 'ja' ? '挿入' : 'Insert'}</button>
            </div>\`).join('');
        }
        
        window.removeImage = function(index) { uploadedImages.splice(index, 1); updatePreview(); };
        window.insertImageMarkdown = function(url, alt) {
          if (!textarea) return;
          const markdownImage = \`![\${alt}](\${url})\\n\`;
          const cursorPos = textarea.selectionStart;
          textarea.value = textarea.value.substring(0, cursorPos) + markdownImage + textarea.value.substring(cursorPos);
          textarea.focus();
          textarea.setSelectionRange(cursorPos + markdownImage.length, cursorPos + markdownImage.length);
        };
      }
      
      document.addEventListener('DOMContentLoaded', initImageUpload);
    </script>
  `;
  res.send(renderLayout(`${wiki.name}/${page} ${getText('edit', lang)}`, body, wiki.favicon, lang, req));
});

app.post('/:address/:page/edit', ensureCanEdit, async (req, res) => { // async
  const { address, page } = req.params;
  const wiki = await wikiByAddress(address);
  if (!wiki) return res.status(404).send(renderLayout('404', 'Wiki not found', null, req.userLang, req));

  const now = new Date().toISOString();
  const content = (req.body.content ?? '').toString();
  const pg = await pageByWikiAndName(wiki.id, page);

  let pageId;
  if (pg) {
    await pool.query('UPDATE pages SET content = $1, updated_at = $2 WHERE id = $3', [content, now, pg.id]);
    pageId = pg.id;
  } else {
    // 新規作成時は RETURNING id を使う
    const newPageRes = await pool.query('INSERT INTO pages(wiki_id, name, content, updated_at) VALUES ($1, $2, $3, $4) RETURNING id', [wiki.id, page, content, now]);
    pageId = newPageRes.rows[0].id;
  }
  
  await pool.query('INSERT INTO revisions(page_id, content, editor_id, created_at) VALUES ($1, $2, $3, $4)', [pageId, content, req.user.id, now]);
  
  res.redirect(`/${wiki.address}/${encodeURIComponent(page)}`);
});

app.get('/:address/:page', async (req, res) => {
  const { address, page } = req.params;
  const lang = req.userLang;
  const wiki = await wikiByAddress(address);
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">❌ ${getText('wikiNotFound', lang)}.</p></div>`, null, lang, req));

  const pg = await pageByWikiAndName(wiki.id, page);
  if (!pg) {
    const isSuspended = !!req.isSuspended;
    const disabledClass = isSuspended ? 'disabled' : '';
    return res.status(404).send(renderLayout(`${wiki.name}/${page}`, `
      <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > <a href="/${wiki.address}">📚 ${wiki.name}</a> > 📄 ${page}</div>
      <div class="card" style="text-align: center;">
        <h1>📄 ${page}</h1><p class="muted">${lang === 'ja' ? 'このページはまだ作成されていません。' : 'This page has not been created yet.'}</p>
        <a class="btn primary ${disabledClass}" href="/${wiki.address}/${encodeURIComponent(page)}/edit">🆕 ${lang === 'ja' ? 'このページを作成' : 'Create this Page'}</a>
      </div>
    `, wiki.favicon, lang, req));
  }

  try {
    pool.query('UPDATE wikis SET views = COALESCE(views, 0) + 1 WHERE id = $1', [wiki.id]);
  } catch (e) {
    console.warn('views update failed', e.message);
  }

  // ✅ 修正: スタブ処理を適用
  const isAdmin = req.isAuthenticated() && ADMIN_USERS.includes(req.user.id);
  const processedContent = processStubs(pg.content || '', isAdmin);
  const html = sanitize(md.render(processedContent)); // ← ここを変更
  
  const isSuspended = !!req.isSuspended;
  const disabledClass = isSuspended ? 'disabled' : '';
  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > <a href="/${wiki.address}">📚 ${wiki.name}</a> > 📄 ${pg.name}</div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 16px;">
      <h1>📄 ${pg.name}</h1>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <a class="btn ${disabledClass}" href="/${wiki.address}/${encodeURIComponent(pg.name)}/edit">✏️ ${getText('edit', lang)}</a>
        <a class="btn ${disabledClass}" href="/${wiki.address}/${encodeURIComponent(pg.name)}/revisions">📋 ${lang === 'ja' ? '履歴' : 'History'}</a>
      </div>
    </div>
    <div class="card content">${html}</div>
    <div class="card"><p class="muted">📅 ${lang === 'ja' ? '最終更新' : 'Last Updated'}: <span class="mono">${new Date(pg.updated_at).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US')}</span></p></div>
  `;
  res.send(renderLayout(`${wiki.name}/${pg.name}`, body, wiki.favicon, lang, req));
});

app.get('/:address', async (req, res) => {
  const wiki = await wikiByAddress(req.params.address); // ✅ awaitを追加
  const lang = req.userLang;
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">❌ ${getText('wikiNotFound', lang)}.</p><a class="btn" href="/">🏠 ${getText('home', lang)}</a></div>`, null, lang, req));
  res.redirect(`/${wiki.address}/home`);
});


// --- Badge Management API (Admin only) ---
app.post('/api/user/:userId/badge', ensureAdmin, async (req, res) => { // async
  const { userId } = req.params;
  const { badgeName, badgeColor } = req.body;
  if (!badgeName) return res.status(400).json({ error: 'Badge name required' });
  
  const now = new Date().toISOString();
  await pool.query('INSERT INTO user_badges(user_id, badge_name, badge_color, granted_by, created_at) VALUES ($1, $2, $3, $4, $5)', 
    [userId, badgeName, badgeColor || '#3498db', req.user.id, now]);
  
  res.json({ success: true });
});

// --- Admin Page Delete Route ---
app.delete('/api/admin/page/:pageId', ensureAdmin, async (req, res) => { // async
  const { pageId } = req.params;
  const now = new Date().toISOString();
  const result = await pool.query('UPDATE pages SET deleted_at = $1 WHERE id = $2', [now, pageId]);
  
  if (result.rowCount === 0) { // changes ではなく rowCount
    return res.status(404).json({ error: 'Page not found' });
  }
  res.json({ success: true });
});

app.get('/api/admin/pages', ensureAdmin, async (req, res) => { // async
  const pagesRes = await pool.query(`
    SELECT p.id, p.name, p.content, p.updated_at, w.name as wiki_name, w.address as wiki_address
    FROM pages p
    JOIN wikis w ON p.wiki_id = w.id
    WHERE p.deleted_at IS NULL AND w.deleted_at IS NULL
    ORDER BY p.updated_at DESC
    LIMIT 50
  `);
  res.json({ pages: pagesRes.rows });
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`🚀 Rec Wiki running on ${BASE_URL}`);
  console.log(`Admin users: ${ADMIN_USERS.join(', ')}`);

});
