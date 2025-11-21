// server.js - PostgreSQL対応版
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
import axios from 'axios';
import { diffChars } from 'diff';

const { Pool } = pg;
const PgSession = pgSession(session);

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_USERS = ['1047797479665578014'];

// PostgreSQL接続プール
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// データベース接続確認
pool.on('connect', () => {
  console.log('✅ PostgreSQL connected');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL error:', err);
});

// ディレクトリ設定
const dataDir = path.join(process.cwd(), 'data');
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

// Markdown & Sanitizer
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const sanitize = (html) =>
  sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']),
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height']
    },
    allowedSchemes: ['http', 'https', 'mailto']
  });

// データベース初期化
async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // テーブル作成
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
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
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
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
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
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        display_name TEXT,
        bio TEXT,
        email TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
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
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_warnings (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        issued_by TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_suspensions (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        reason TEXT NOT NULL,
        issued_by TEXT NOT NULL,
        expires_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS user_languages (
        user_id TEXT PRIMARY KEY,
        language TEXT DEFAULT 'ja'
      );

      CREATE TABLE IF NOT EXISTS wiki_settings (
        wiki_id INTEGER PRIMARY KEY REFERENCES wikis(id) ON DELETE CASCADE,
        mode TEXT DEFAULT 'loggedin',
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
        invited_tag TEXT,
        invited_id TEXT,
        role TEXT DEFAULT 'editor',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // インデックス作成
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pages_wiki_id ON pages(wiki_id);
      CREATE INDEX IF NOT EXISTS idx_pages_name ON pages(name);
      CREATE INDEX IF NOT EXISTS idx_wikis_owner_id ON wikis(owner_id);
      CREATE INDEX IF NOT EXISTS idx_wikis_address ON wikis(address);
      CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
      CREATE INDEX IF NOT EXISTS idx_revisions_page_id ON revisions(page_id);
      CREATE INDEX IF NOT EXISTS idx_revisions_editor_id ON revisions(editor_id);
    `);

    // 初期データ挿入
    await client.query(
      'INSERT INTO allowed_users(user_id) VALUES ($1) ON CONFLICT DO NOTHING',
      ['1047797479665578014']
    );

    await client.query('COMMIT');
    console.log('✅ Database initialized successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Database initialization error:', error);
    throw error;
  } finally {
    client.release();
  }
}

// 言語辞書
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

// Passport設定
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
  } catch (error) {
    console.error('Passport error:', error);
    done(error);
  }
}));

// ミドルウェア
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  store: new PgSession({
    pool,
    tableName: 'session'
  }),
  secret: process.env.SESSION_SECRET || 'change_me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30日
    secure: process.env.NODE_ENV === 'production'
  }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use('/public', express.static(path.join(process.cwd(), 'public')));
app.use('/uploads', express.static(uploadDir));
app.set('trust proxy', 1);

// ユーザー言語とサスペンション確認ミドルウェア
app.use(async (req, res, next) => {
  req.isSuspended = false;
  if (req.isAuthenticated()) {
    try {
      const langResult = await pool.query(
        'SELECT language FROM user_languages WHERE user_id = $1',
        [req.user.id]
      );
      req.userLang = langResult.rows[0]?.language || 'ja';

      const suspensionResult = await pool.query(
        'SELECT * FROM user_suspensions WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1',
        [req.user.id]
      );
      
      if (suspensionResult.rows.length > 0) {
        req.isSuspended = true;
        req.suspensionDetails = suspensionResult.rows[0];
      }
    } catch (error) {
      console.error('Middleware error:', error);
    }
  } else {
    req.userLang = req.session.language || 'ja';
  }
  next();
});

// ヘルパー関数
const getText = (key, lang = 'ja') => i18n[lang]?.[key] || i18n.ja[key] || key;

const createSuspensionBlock = (req) => {
  const lang = req.userLang;
  const body = `<div class="card"><p class="danger">⛔ ${lang === 'ja' ? 'アカウントが停止されているため、この操作は実行できません。' : 'Your account is suspended, and you cannot perform this action.'}</p><a class="btn" href="/">戻る</a></div>`;
  return renderLayout('Suspended', body, null, lang, req);
};

const ensureAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
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
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">⛔ Wiki not found.</p></div>`, null, req.userLang, req));

  const permResult = await pool.query(
    'SELECT role FROM wiki_permissions WHERE wiki_id = $1 AND editor_id = $2',
    [wiki.id, req.user.id]
  );
  
  if (wiki.owner_id === req.user.id || 
      (permResult.rows[0]?.role === 'admin') || 
      ADMIN_USERS.includes(req.user.id)) {
    return next();
  }

  return res.status(403).send(renderLayout('Forbidden', `<div class="card"><p class="danger">⛔ ${req.userLang === 'ja' ? 'Wikiの管理権限がありません' : 'You do not have administrative permissions for this wiki'}.</p><a class="btn" href="/${wiki.address}">${req.userLang === 'ja' ? '戻る' : 'Back'}</a></div>`, null, req.userLang, req));
};

const ensureCanEdit = async (req, res, next) => {
  if (!req.isAuthenticated()) return res.redirect('/auth/discord');
  if (req.isSuspended) return res.status(403).send(createSuspensionBlock(req));
  
  const address = req.params.address;
  const wiki = await wikiByAddress(address);
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">⛔ ${req.userLang === 'ja' ? 'Wikiが見つかりません' : 'Wiki not found'}.</p></div>`, null, req.userLang, req));

  if (wiki.owner_id === req.user.id) return next();
  if (ADMIN_USERS.includes(req.user.id)) return next();

  const permResult = await pool.query(
    'SELECT * FROM wiki_permissions WHERE wiki_id = $1 AND editor_id = $2',
    [wiki.id, req.user.id]
  );
  if (permResult.rows.length > 0) return next();

  const settingResult = await pool.query(
    'SELECT mode FROM wiki_settings WHERE wiki_id = $1',
    [wiki.id]
  );
  const mode = settingResult.rows[0]?.mode || 'loggedin';

  if (mode === 'anyone') return next();
  if (mode === 'loggedin') return next();
  
  return res.status(403).send(renderLayout('Forbidden', `<div class="card"><p class="danger">⛔ ${req.userLang === 'ja' ? '編集権限がありません' : 'No edit permission'}.</p><a class="btn" href="/${wiki.address}">${req.userLang === 'ja' ? '戻る' : 'Back'}</a></div>`, null, req.userLang, req));
};

const wikiByAddress = async (address) => {
  const result = await pool.query(
    'SELECT * FROM wikis WHERE address = $1 AND deleted_at IS NULL',
    [address]
  );
  return result.rows[0];
};

const pageByWikiAndName = async (wikiId, name) => {
  const result = await pool.query(
    'SELECT * FROM pages WHERE wiki_id = $1 AND name = $2 AND deleted_at IS NULL',
    [wikiId, name]
  );
  return result.rows[0];
};

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
    .header-center { 
      flex: 1; 
      text-align: center; 
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .header-right { justify-content: flex-end; }
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
    .btn.disabled { pointer-events: none; cursor: not-allowed; opacity: 0.6; }
    input, textarea, select { 
      width: 100%; 
      padding: 12px; 
      border: 1px solid var(--border-color); 
      border-radius: 8px; 
      background-color: var(--card-bg); 
      color: var(--text-primary); 
      font-size: 14px; 
    }
    textarea { min-height: 400px; font-family: 'Monaco', 'Menlo', monospace; resize: vertical; }
    .card { 
      border: 1px solid var(--border-color); 
      padding: 24px; 
      border-radius: 12px; 
      background-color: var(--card-bg); 
      margin-bottom: 20px; 
    }
    .muted { color: var(--text-secondary); }
    .mono { font-family: monospace; }
    .breadcrumb { margin-bottom: 20px; font-size: 14px; }
    .breadcrumb a { color: var(--accent-color); text-decoration: none; }
    @media (max-width: 768px) {
      body { padding: 16px 16px 80px 16px; }
    }
  </style>
</head>
<body data-theme="light">
${suspensionBanner}
<header>
  <div class="header-left">
    <a class="btn" href="/">🏠 ${getText('home', lang)}</a>
  </div>
  <div class="header-center">
    <h1 style="margin: 0;"><a href="/" style="text-decoration: none; color: var(--text-primary);">Rec Wiki</a></h1>
  </div>
  <div class="header-right">
    <button class="btn" onclick="toggleTheme()">🌓</button>
    <div id="auth"></div>
  </div>
</header>
${body}
<script>
function toggleTheme() {
  const body = document.body;
  const newTheme = body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  body.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
}
document.body.setAttribute('data-theme', localStorage.getItem('theme') || 'light');

fetch('/api/me').then(r => r.json()).then(me => {
  const el = document.getElementById('auth');
  if (!el) return;
  if (me.loggedIn) {
    el.innerHTML = \`<img src="\${me.avatar}" alt="avatar" style="width:36px;height:36px;border-radius:50%;">\`;
  } else {
    el.innerHTML = '<a class="btn primary" href="/auth/discord">${getText('login', lang)}</a>';
  }
});
</script>
</body>
</html>`;
};

// ===== ルート定義 =====

// 認証
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback',
  passport.authenticate('discord', { failureRedirect: '/' }),
  (req, res) => res.redirect('/create-wiki')
);
app.get('/logout', (req, res) => {
  req.logout(() => {});
  res.redirect('/');
});

// API: 現在のユーザー
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

// 言語切り替え
app.get('/lang/:lang', async (req, res) => {
  const { lang } = req.params;
  if (!['ja', 'en'].includes(lang)) return res.redirect('/');
  
  if (req.isAuthenticated()) {
    await pool.query(
      'INSERT INTO user_languages(user_id, language) VALUES ($1, $2) ON CONFLICT(user_id) DO UPDATE SET language = $2',
      [req.user.id, lang]
    );
  } else {
    req.session.language = lang;
  }
  
  res.redirect(req.get('Referer') || '/');
});

// ホーム
app.get('/', async (req, res) => {
  const lang = req.userLang;
  const isSuspended = !!req.isSuspended;
  const disabledClass = isSuspended ? 'disabled' : '';

  const body = `
    <div class="breadcrumb">🏠 ${getText('home', lang)}</div>
    <div style="text-align: center; margin-bottom: 24px;">
      <h2>Welcome to Rec Wiki</h2>
      <p class="muted">${lang === 'ja' ? 'Discord連携済みユーザーがWikiを作成できます。' : 'Discord users can create wikis.'}</p>
      <a class="btn primary ${disabledClass}" href="/create-wiki">🆕 ${getText('createWiki', lang)}</a>
    </div>
    <div class="card">
      <h3>📚 ${getText('popularWikis', lang)}</h3>
      <div id="wiki-list">Loading...</div>
    </div>
    <script>
      fetch('/api/wikis?limit=10').then(r => r.json()).then(data => {
        const listEl = document.getElementById('wiki-list');
        if (!data.wikis.length) {
          listEl.innerHTML = '<p class="muted">${lang === 'ja' ? 'Wikiがまだありません。' : 'No wikis yet.'}</p>';
          return;
        }
        listEl.innerHTML = data.wikis.map(w => \`
          <div class="card">
            <h3><a href="/\${w.address}">\${w.name}</a></h3>
            <p class="muted">Views: \${w.views || 0}</p>
            <a class="btn" href="/\${w.address}">📖 ${getText('view', lang)}</a>
          </div>
        \`).join('');
      });
    </script>
  `;
  res.send(renderLayout('Rec Wiki', body, null, lang, req));
});

// API: Wikiリスト
app.get('/api/wikis', async (req, res) => {
  const skip = parseInt(req.query.skip || '0', 10);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));
  
  try {
    const result = await pool.query(`
      SELECT w.id, w.name, w.address, w.favicon, w.created_at, w.views 
      FROM wikis w
      LEFT JOIN wiki_settings ws ON w.id = ws.wiki_id
      WHERE w.deleted_at IS NULL AND (ws.is_searchable = 1 OR ws.is_searchable IS NULL)
      ORDER BY w.views DESC, w.created_at DESC 
      LIMIT $1 OFFSET $2
    `, [limit, skip]);
    
    res.json({ wikis: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('API wikis error:', error);
    res.status(500).json({ error: 'Failed to fetch wikis' });
  }
});

// Wiki作成フォーム
app.get('/create-wiki', ensureCanCreate, (req, res) => {
  const lang = req.userLang;
  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > 🆕 ${getText('createWiki', lang)}</div>
    <h1>🆕 ${lang === 'ja' ? '新しいWikiを作成' : 'Create a New Wiki'}</h1>
    <form action="/create-wiki" method="post" enctype="multipart/form-data" class="card">
      <div class="form-group">
        <label>📝 ${lang === 'ja' ? 'Wiki名(表示名、一意)' : 'Wiki Name (Display Name, Unique)'}</label>
        <input name="name" required placeholder="e.g., MyTeamWiki" maxlength="100">
      </div>
      <div class="form-group">
        <label>🔗 ${lang === 'ja' ? 'アドレス(URL用、一意、英数字とハイフンのみ)' : 'Address (For URL, Unique, Alphanumeric & Hyphens only)'}</label>
        <input name="address" required pattern="[a-zA-Z0-9-]{2,64}" placeholder="e.g., my-team-wiki" maxlength="64">
      </div>
      <div class="form-group">
        <label>🌐 ${lang === 'ja' ? 'ファビコンURL(オプション)' : 'Favicon URL (Optional)'}</label>
        <input name="faviconUrl" placeholder="https://.../favicon.png">
      </div>
      <div class="form-group">
        <label>🔒 ${lang === 'ja' ? '初期公開設定' : 'Initial Access Setting'}</label>
        <select name="initialMode">
          <option value="loggedin" selected>${lang === 'ja' ? 'ログインユーザーのみ(デフォルト)' : 'Logged-in users only (Default)'}</option>
          <option value="anyone">${lang === 'ja' ? '誰でも(公開編集)' : 'Anyone (Public editing)'}</option>
          <option value="invite">${lang === 'ja' ? '招待のみ(オーナーが招待)' : 'Invite only (Owner invites)'}</option>
        </select>
      </div>
      <div class="form-group">
        <div class="cf-turnstile" data-sitekey="${process.env.TURNSTILE_SITE_KEY || '1x00000000000000000000AA'}"></div>
      </div>
      <button class="btn success" type="submit">🚀 ${lang === 'ja' ? '作成' : 'Create'}</button>
    </form>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  `;
  res.send(renderLayout(`${getText('createWiki', lang)}`, body, null, lang, req));
});

// Wiki作成処理
const upload = multer({ dest: uploadDir });
app.post('/create-wiki', ensureCanCreate, upload.single('faviconFile'), async (req, res) => {
  const lang = req.userLang;

  // Cloudflare Turnstile認証
  try {
    const token = req.body['cf-turnstile-response'];
    const ip = req.headers['cf-connecting-ip'] || req.ip;

    const formData = new URLSearchParams();
    formData.append('secret', process.env.TURNSTILE_SECRET_KEY);
    formData.append('response', token);
    formData.append('remoteip', ip);

    const result = await axios.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', formData);
    if (!result.data.success) {
      return res.status(403).send(renderLayout('Error', `<div class="card"><p class="danger">⛔ ${lang === 'ja' ? '認証に失敗しました。' : 'Authentication failed.'}</p></div>`, null, lang, req));
    }
  } catch (error) {
    console.error('Turnstile verification failed:', error.message);
    return res.status(500).send(renderLayout('Error', `<div class="card"><p class="danger">⛔ ${lang === 'ja' ? '認証サーバーでエラーが発生しました。' : 'Authentication server error.'}</p></div>`, null, lang, req));
  }
  
  const { name, address, faviconUrl, initialMode } = req.body;
  const slug = (address || '').trim();
  const wname = (name || '').trim();

  if (!/^[a-zA-Z0-9-]{2,64}$/.test(slug)) {
    return res.status(400).send(renderLayout('Error', `<div class="card"><p class="danger">⛔ ${lang === 'ja' ? '無効なアドレス形式です。' : 'Invalid address format.'}</p><a class="btn" href="/create-wiki">🔙 Back</a></div>`, null, lang, req));
  }
  if (!wname) {
    return res.status(400).send(renderLayout('Error', `<div class="card"><p class="danger">⛔ ${lang === 'ja' ? 'Wiki名は必須です。' : 'Wiki name is required.'}</p><a class="btn" href="/create-wiki">🔙 Back</a></div>`, null, lang, req));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existsResult = await client.query(
      'SELECT 1 FROM wikis WHERE name = $1 OR address = $2',
      [wname, slug]
    );
    
    if (existsResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).send(renderLayout('Duplicate', `<div class="card"><p class="danger">⛔ ${lang === 'ja' ? 'Wiki名またはアドレスが既に使用されています。' : 'Wiki name or address already in use.'}</p><a class="btn" href="/create-wiki">🔙 Back</a></div>`, null, lang, req));
    }

    let faviconPath = (faviconUrl && /^https?:\/\//.test(faviconUrl)) ? faviconUrl.trim() : null;
    if (req.file) {
      faviconPath = `/uploads/${req.file.filename}`;
    }

    const wikiResult = await client.query(
      'INSERT INTO wikis(name, address, favicon, owner_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [wname, slug, faviconPath, req.user.id]
    );
    const wikiId = wikiResult.rows[0].id;

    const welcomeText = lang === 'ja' ? 
      `# ${wname}\n\n🎉 このWikiへようこそ！\n\n## はじめに\nこのページを編集してWikiを構築しましょう。\n\n## 機能\n- 📝 Markdownでページ作成\n- 🖼️ 画像アップロード対応\n- 🌓 ダークテーマ切替\n- 📱 レスポンシブデザイン\n- 📚 改訂履歴` :
      `# ${wname}\n\n🎉 Welcome to this Wiki!\n\n## Getting Started\nEdit this page to start building your wiki.\n\n## Features\n- 📝 Create pages with Markdown\n- 🖼️ Image upload support\n- 🌓 Dark theme toggle\n- 📱 Responsive design\n- 📚 Revision history`;

    const pageResult = await client.query(
      'INSERT INTO pages(wiki_id, name, content) VALUES ($1, $2, $3) RETURNING id',
      [wikiId, 'home', welcomeText]
    );
    const pageId = pageResult.rows[0].id;

    await client.query(
      'INSERT INTO revisions(page_id, content, editor_id) VALUES ($1, $2, $3)',
      [pageId, welcomeText, req.user.id]
    );

    const mode = ['anyone', 'loggedin', 'invite'].includes(initialMode) ? initialMode : 'loggedin';
    await client.query(
      'INSERT INTO wiki_settings(wiki_id, mode) VALUES ($1, $2)',
      [wikiId, mode]
    );

    await client.query(
      'INSERT INTO wiki_permissions(wiki_id, editor_id, role) VALUES ($1, $2, $3)',
      [wikiId, req.user.id, 'admin']
    );

    await client.query('COMMIT');
    res.redirect(`/${slug}-edit`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create wiki error:', error);
    res.status(500).send(renderLayout('Error', `<div class="card"><p class="danger">⛔ Wiki作成に失敗しました。</p></div>`, null, lang, req));
  } finally {
    client.release();
  }
});

// Wiki編集ダッシュボード
app.get('/:address-edit', ensureCanEdit, async (req, res) => {
  const lang = req.userLang;
  const wiki = await wikiByAddress(req.params.address);
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">⛔ ${getText('wikiNotFound', lang)}.</p></div>`, null, lang, req));

  try {
    const pagesResult = await pool.query(
      'SELECT name FROM pages WHERE wiki_id = $1 AND deleted_at IS NULL ORDER BY name ASC',
      [wiki.id]
    );
    const pages = pagesResult.rows;

    const settingsResult = await pool.query(
      'SELECT mode, is_searchable FROM wiki_settings WHERE wiki_id = $1',
      [wiki.id]
    );
    const settings = settingsResult.rows[0] || { mode: 'loggedin', is_searchable: 1 };

    const permsResult = await pool.query(
      'SELECT editor_id, role FROM wiki_permissions WHERE wiki_id = $1',
      [wiki.id]
    );
    const perms = permsResult.rows;

    const invitesResult = await pool.query(
      'SELECT id, invited_tag, invited_id, role, created_at FROM wiki_invites WHERE wiki_id = $1 ORDER BY created_at DESC',
      [wiki.id]
    );
    const invites = invitesResult.rows;

    const allPages = pages.map(p => `<a class="chip" href="/${wiki.address}/${encodeURIComponent(p.name)}/edit">📄 ${p.name}</a>`).join('');
    const permsHtml = perms.map(p => `<div><strong>${p.editor_id}</strong> — <span class="muted">${p.role}</span></div>`).join('') || `<div class="muted">${lang === 'ja' ? '明示的な編集者なし' : 'No explicit editors'}</div>`;
    const invitesHtml = invites.map(i => `<div><strong>${i.invited_tag || (i.invited_id || '—')}</strong> — <span class="muted">${i.role}</span></div>`).join('') || `<div class="muted">${lang === 'ja' ? '保留中の招待なし' : 'No pending invites'}</div>`;

    const isOwner = wiki.owner_id === req.user.id;
    const isAdmin = ADMIN_USERS.includes(req.user.id);
    const canChangeAdvancedSettings = isOwner || isAdmin;

    let advancedSettingsHtml = '';
    if (canChangeAdvancedSettings) {
      advancedSettingsHtml = `
        <hr style="margin:16px 0;">
        <h3>🔍 ${lang === 'ja' ? '検索掲載' : 'Search Indexing'}</h3>
        <div class="form-group">
          <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
            <input type="checkbox" name="is_searchable" ${settings.is_searchable ? 'checked' : ''} form="perm-form">
            <span>${lang === 'ja' ? '検索エンジンやWiki一覧に掲載する' : 'Allow listing in search engines'}</span>
          </label>
        </div>
      `;
    }
    
    const body = `
      <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > <a href="/${wiki.address}">📚 ${wiki.name}</a> > ✏️ ${getText('edit', lang)} Dashboard</div>
      <h1>✏️ ${wiki.name} Dashboard</h1>
      <div class="row">
        <div class="card">
          <h2>📄 ${getText('pages', lang)} (${pages.length})</h2>
          <div class="list">${allPages || `<span class="muted">${lang === 'ja' ? 'ページがまだありません' : 'No pages yet'}.</span>`}</div>
          <form onsubmit="event.preventDefault(); location.href='/${wiki.address}/'+encodeURIComponent(this.page.value)+'/edit'">
            <div class="form-group">
              <label>🔍 ${lang === 'ja' ? '新規または既存のページ名' : 'New or Existing Page Name'}</label>
              <input name="page" required placeholder="e.g., getting-started">
            </div>
            <button class="btn success" type="submit">🚀 ${lang === 'ja' ? 'エディタを開く' : 'Open Editor'}</button>
          </form>
        </div>

        <div class="card">
          <h2>📊 Wiki ${lang === 'ja' ? '情報' : 'Info'}</h2>
          <p><strong>📝 ${lang === 'ja' ? 'アドレス' : 'Address'}:</strong> ${wiki.address}</p>
          <p><strong>👁️ ${lang === 'ja' ? '閲覧数' : 'Views'}:</strong> ${wiki.views || 0}</p>
          <p><strong>📄 ${getText('pages', lang)}:</strong> ${pages.length}</p>

          <hr style="margin:16px 0;">
          <h3>🔒 ${lang === 'ja' ? '権限設定' : 'Permission Settings'}</h3>
          <form id="perm-form" action="/${wiki.address}/settings" method="post">
            <div class="form-group">
              <label>${lang === 'ja' ? '公開モード' : 'Access Mode'}</label>
              <select name="mode">
                <option value="anyone" ${settings.mode === 'anyone' ? 'selected' : ''}>${lang === 'ja' ? '誰でも' : 'Anyone'}</option>
                <option value="loggedin" ${settings.mode === 'loggedin' ? 'selected' : ''}>${lang === 'ja' ? 'ログインユーザー' : 'Logged-in users'}</option>
                <option value="invite" ${settings.mode === 'invite' ? 'selected' : ''}>${lang === 'ja' ? '招待のみ' : 'Invite only'}</option>
              </select>
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
          <form id="add-perm" onsubmit="event.preventDefault(); addPermission();">
            <div class="form-group">
              <label>Discord ID</label>
              <input name="editor_id" placeholder="123456789012345678">
            </div>
            <div class="form-group">
              <label>${lang === 'ja' ? '役割' : 'Role'}</label>
              <input name="role" placeholder="editor / admin">
            </div>
            <button class="btn" type="submit">${lang === 'ja' ? '追加' : 'Add'}</button>
          </form>
        </div>

        <div class="card">
          <h3>✉️ ${lang === 'ja' ? '招待' : 'Invites'}</h3>
          ${invitesHtml}
          <form id="invite-form" onsubmit="event.preventDefault(); sendInvite();">
            <div class="form-group">
              <label>Discord Tag</label>
              <input name="invited_tag" placeholder="Username#1234">
            </div>
            <div class="form-group">
              <label>${lang === 'ja' ? '役割' : 'Role'}</label>
              <input name="role" placeholder="editor">
            </div>
            <button class="btn" type="submit">${lang === 'ja' ? '招待を作成' : 'Create Invite'}</button>
          </form>
        </div>
      </div>

      <script>
        async function addPermission() {
          const form = document.getElementById('add-perm');
          const editor_id = form.editor_id.value.trim();
          const role = form.role.value.trim() || 'editor';
          if (!editor_id) return alert('Discord IDを入力してください');
          const res = await fetch('/${wiki.address}/permissions', { 
            method: 'POST', 
            headers: {'Content-Type':'application/json'}, 
            body: JSON.stringify({ editor_id, role })
          });
          if (res.ok) location.reload();
          else alert('Failed to add permission');
        }

        async function sendInvite() {
          const form = document.getElementById('invite-form');
          const invited_tag = form.invited_tag.value.trim();
          const role = form.role.value.trim() || 'editor';
          if (!invited_tag) return alert('Discord Tagを入力してください');
          const res = await fetch('/${wiki.address}/invite', { 
            method: 'POST', 
            headers: {'Content-Type':'application/json'}, 
            body: JSON.stringify({ invited_tag, role })
          });
          if (res.ok) { alert('招待を作成しました'); location.reload(); }
          else { alert('招待に失敗しました'); }
        }
      </script>
    `;
    res.send(renderLayout(`${wiki.name} ${getText('edit', lang)}`, body, wiki.favicon, lang, req));
  } catch (error) {
    console.error('Edit dashboard error:', error);
    res.status(500).send(renderLayout('Error', `<div class="card"><p class="danger">⛔ エラーが発生しました</p></div>`, null, lang, req));
  }
});

// Wiki設定更新
app.post('/:address/settings', ensureCanAdministerWiki, async (req, res) => {
  const wiki = await wikiByAddress(req.params.address);
  if (!wiki) return res.status(404).send('Wiki not found');
  
  const mode = ['anyone', 'loggedin', 'invite'].includes(req.body.mode) ? req.body.mode : 'loggedin';
  const isSearchable = req.body.is_searchable === 'on' ? 1 : 0;
  
  const isOwner = wiki.owner_id === req.user.id;
  const isAdmin = ADMIN_USERS.includes(req.user.id);

  try {
    if (isOwner || isAdmin) {
      await pool.query(`
        INSERT INTO wiki_settings (wiki_id, mode, is_searchable) 
        VALUES ($1, $2, $3) 
        ON CONFLICT(wiki_id) DO UPDATE SET 
          mode = EXCLUDED.mode, 
          is_searchable = EXCLUDED.is_searchable
      `, [wiki.id, mode, isSearchable]);
    } else {
      await pool.query(
        'UPDATE wiki_settings SET mode = $1 WHERE wiki_id = $2',
        [mode, wiki.id]
      );
    }

    res.redirect(`/${wiki.address}-edit`);
  } catch (error) {
    console.error('Settings update error:', error);
    res.status(500).send('Failed to update settings');
  }
});

// 権限追加
app.post('/:address/permissions', ensureCanAdministerWiki, async (req, res) => {
  const wiki = await wikiByAddress(req.params.address);
  if (!wiki) return res.status(404).json({ error: 'not found' });
  
  const { editor_id, role } = req.body;
  if (!editor_id) return res.status(400).json({ error: 'missing editor_id' });
  
  try {
    await pool.query(
      'INSERT INTO wiki_permissions(wiki_id, editor_id, role) VALUES ($1, $2, $3) ON CONFLICT(wiki_id, editor_id) DO UPDATE SET role = $3',
      [wiki.id, editor_id, role || 'editor']
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Permissions error:', error);
    res.status(500).json({ error: 'failed' });
  }
});

// 招待作成
app.post('/:address/invite', ensureCanAdministerWiki, async (req, res) => {
  const wiki = await wikiByAddress(req.params.address);
  if (!wiki) return res.status(404).json({ error: 'not found' });
  
  const { invited_tag, role } = req.body;
  if (!invited_tag) return res.status(400).json({ error: 'missing invited_tag' });
  
  try {
    await pool.query(
      'INSERT INTO wiki_invites(wiki_id, invited_tag, role) VALUES ($1, $2, $3)',
      [wiki.id, invited_tag, role || 'editor']
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Invite error:', error);
    res.status(500).json({ error: 'failed' });
  }
});

// ページ編集
app.get('/:address/:page/edit', ensureCanEdit, async (req, res) => {
  const { address, page } = req.params;
  const lang = req.userLang;
  const wiki = await wikiByAddress(address);
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">⛔ ${getText('wikiNotFound', lang)}.</p></div>`, null, lang, req));

  const pg = await pageByWikiAndName(wiki.id, page);
  const content = pg ? pg.content : '';

  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > <a href="/${wiki.address}">📚 ${wiki.name}</a> > <a href="/${wiki.address}/${encodeURIComponent(page)}">📄 ${page}</a> > ✏️ ${getText('edit', lang)}</div>
    <h1>✏️ ${wiki.name} / ${page}</h1>
    <form method="post" action="/${wiki.address}/${encodeURIComponent(page)}/edit" class="card">
      <div class="form-group">
        <label>📄 Markdown Content</label>
        <textarea name="content" placeholder="# Start with a heading!">${content.replace(/</g,'&lt;')}</textarea>
      </div>
      <button class="btn success" type="submit">💾 ${getText('save', lang)}</button>
    </form>
  `;
  res.send(renderLayout(`${wiki.name}/${page} ${getText('edit', lang)}`, body, wiki.favicon, lang, req));
});

// ページ保存
app.post('/:address/:page/edit', ensureCanEdit, async (req, res) => {
  const { address, page } = req.params;
  const wiki = await wikiByAddress(address);
  if (!wiki) return res.status(404).send('Wiki not found');

  const content = (req.body.content ?? '').toString();
  const pg = await pageByWikiAndName(wiki.id, page);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (pg) {
      await client.query(
        'UPDATE pages SET content = $1, updated_at = NOW() WHERE id = $2',
        [content, pg.id]
      );
      await client.query(
        'INSERT INTO revisions(page_id, content, editor_id) VALUES ($1, $2, $3)',
        [pg.id, content, req.user.id]
      );
    } else {
      const pageResult = await client.query(
        'INSERT INTO pages(wiki_id, name, content) VALUES ($1, $2, $3) RETURNING id',
        [wiki.id, page, content]
      );
      const pageId = pageResult.rows[0].id;
      await client.query(
        'INSERT INTO revisions(page_id, content, editor_id) VALUES ($1, $2, $3)',
        [pageId, content, req.user.id]
      );
    }

    await client.query('COMMIT');
    res.redirect(`/${address}/${encodeURIComponent(page)}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Page save error:', error);
    res.status(500).send('Failed to save page');
  } finally {
    client.release();
  }
});

// ページ表示
app.get('/:address/:page', async (req, res) => {
  const { address, page } = req.params;
  const lang = req.userLang;
  const wiki = await wikiByAddress(address);
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">⛔ ${getText('wikiNotFound', lang)}.</p></div>`, null, lang, req));

  const pg = await pageByWikiAndName(wiki.id, page);
  if (!pg) {
    return res.status(404).send(renderLayout(`${wiki.name}/${page}`, `
      <div class="card" style="text-align: center;">
        <h1>📄 ${page}</h1>
        <p class="muted">${lang === 'ja' ? 'このページはまだ作成されていません。' : 'This page has not been created yet.'}</p>
        <a class="btn primary" href="/${wiki.address}/${encodeURIComponent(page)}/edit">🆕 ${lang === 'ja' ? 'このページを作成' : 'Create this Page'}</a>
      </div>
    `, wiki.favicon, lang, req));
  }

  try {
    await pool.query('UPDATE wikis SET views = COALESCE(views, 0) + 1 WHERE id = $1', [wiki.id]);
  } catch (e) {
    console.warn('views update failed', e.message);
  }

  const html = sanitize(md.render(pg.content));
  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > <a href="/${wiki.address}">📚 ${wiki.name}</a> > 📄 ${pg.name}</div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
      <h1>📄 ${pg.name}</h1>
      <div style="display: flex; gap: 8px;">
        <a class="btn" href="/${wiki.address}/${encodeURIComponent(pg.name)}/edit">✏️ ${getText('edit', lang)}</a>
      </div>
    </div>
    <div class="card content">${html}</div>
    <div class="card"><p class="muted">📅 ${lang === 'ja' ? '最終更新' : 'Last Updated'}: ${new Date(pg.updated_at).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US')}</p></div>
  `;
  res.send(renderLayout(`${wiki.name}/${pg.name}`, body, wiki.favicon, lang, req));
});

// Wikiホームへリダイレクト
app.get('/:address', async (req, res) => {
  const wiki = await wikiByAddress(req.params.address);
  const lang = req.userLang;
  if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">⛔ ${getText('wikiNotFound', lang)}.</p></div>`, null, lang, req));
  res.redirect(`/${wiki.address}/home`);
});

// ダッシュボード
app.get('/dashboard', ensureAuth, async (req, res) => {
  const lang = req.userLang;
  const userId = req.user.id;
  
  try {
    const ownedWikisResult = await pool.query(
      'SELECT * FROM wikis WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
      [userId]
    );
    const ownedWikis = ownedWikisResult.rows;
    
    const editableWikisResult = await pool.query(`
      SELECT w.* FROM wikis w 
      JOIN wiki_permissions wp ON w.id = wp.wiki_id 
      WHERE wp.editor_id = $1 AND w.owner_id != $1 AND w.deleted_at IS NULL
    `, [userId]);
    const editableWikis = editableWikisResult.rows;
    
    const recentEditsResult = await pool.query(`
      SELECT p.name as page_name, w.name as wiki_name, w.address as wiki_address, r.created_at
      FROM revisions r
      JOIN pages p ON r.page_id = p.id 
      JOIN wikis w ON p.wiki_id = w.id
      WHERE r.editor_id = $1 AND w.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY r.created_at DESC LIMIT 10
    `, [userId]);
    const recentEdits = recentEditsResult.rows;

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
              <a class="btn" href="/${w.address}-edit">${getText('edit', lang)}</a>
            </div>
          `).join('') : `<p class="muted">${lang === 'ja' ? '所有Wikiがありません。' : 'No owned wikis.'}</p>`}
        </div>
        
        <div class="card">
          <h3>✏️ ${lang === 'ja' ? '編集可能Wiki' : 'Editable Wikis'}</h3>
          ${editableWikis.length ? editableWikis.map(w => `
            <div style="margin-bottom: 12px; padding: 12px; background: var(--bg-secondary); border-radius: 8px;">
              <h4 style="margin: 0;"><a href="/${w.address}">${w.name}</a></h4>
              <p class="muted">${w.address}</p>
              <a class="btn" href="/${w.address}-edit">${getText('edit', lang)}</a>
            </div>
          `).join('') : `<p class="muted">${lang === 'ja' ? '編集可能Wikiがありません。' : 'No editable wikis.'}</p>`}
        </div>
      </div>

      <div class="card">
        <h3>🕒 ${getText('recentEdits', lang)}</h3>
        ${recentEdits.length ? recentEdits.map(e => `
          <div style="margin-bottom: 12px; padding: 12px; background: var(--bg-secondary); border-radius: 8px;">
            <a href="/${e.wiki_address}/${encodeURIComponent(e.page_name)}">📄 ${e.page_name}</a> 
            in 
            <a href="/${e.wiki_address}">📚 ${e.wiki_name}</a>
            <div class="muted">${new Date(e.created_at).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US')}</div>
          </div>
        `).join('') : `<p class="muted">${lang === 'ja' ? '最近の編集がありません。' : 'No recent edits.'}</p>`}
      </div>
    `;
    
    res.send(renderLayout(`${getText('dashboard', lang)}`, body, null, lang, req));
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send(renderLayout('Error', `<div class="card"><p class="danger">⛔ エラーが発生しました</p></div>`, null, lang, req));
  }
});

// 管理者ダッシュボード
app.get('/admin', ensureAdmin, async (req, res) => {
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

    <div class="card">
      <h3>📚 ${getText('wikis', lang)} Management</h3>
      <div id="wiki-management">Loading...</div>
    </div>

    <script>
      fetch('/api/admin/stats').then(r => r.json()).then(data => {
        document.getElementById('admin-stats').innerHTML = \`
          <p><strong>Total Wikis:</strong> \${data.totalWikis}</p>
          <p><strong>Total Pages:</strong> \${data.totalPages}</p>
          <p><strong>Total Users:</strong> \${data.totalUsers}</p>
          <p><strong>Total Revisions:</strong> \${data.totalRevisions}</p>
        \`;
      });

      fetch('/api/admin/wikis').then(r => r.json()).then(data => {
        const html = data.wikis.map(w => \`
          <div class="card" style="margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <h4 style="margin: 0;">\${w.name}</h4>
                <p class="muted">Address: \${w.address} • Views: \${w.views}</p>
              </div>
              <button class="btn danger" onclick="deleteWiki('\${w.id}', '\${w.name}')">Delete</button>
            </div>
          </div>
        \`).join('');
        document.getElementById('wiki-management').innerHTML = html || '<p class="muted">No wikis found.</p>';
      });

      async function searchUser() {
        const userId = document.getElementById('user-search').value.trim();
        if (!userId) return;
        
        const data = await fetch(\`/api/admin/user/\${userId}\`).then(r => r.json());
        const resultsEl = document.getElementById('user-search-results');
        
        if (data.error) {
          resultsEl.innerHTML = \`<p class="danger">\${data.error}</p>\`;
          return;
        }
        
        const warnings = data.warnings.map(w => \`
          <div>⚠️ \${w.reason} (by \${w.issued_by})</div>
        \`).join('') || '<div class="muted">No warnings</div>';
        
        const suspension = data.suspension ? \`
          <div class="danger">🚫 \${data.suspension.type === 'permanent' ? 'Permanently banned' : 'Temporarily suspended'}: \${data.suspension.reason}</div>
        \` : '<div class="muted">Not suspended</div>';
        
        resultsEl.innerHTML = \`
          <div class="card">
            <h4>User ID: \${userId}</h4>
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
      }

      async function warnUser(userId) {
        const reason = prompt('Warning reason:');
        if (!reason) return;
        
        const res = await fetch(\`/api/admin/user/\${userId}/warn\`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ reason })
        });
        if (res.ok) {
          alert('Warning issued');
          searchUser();
        } else {
          alert('Failed to issue warning');
        }
      }

      async function suspendUser(userId) {
        const reason = prompt('Suspension reason:');
        if (!reason) return;
        const days = prompt('Days to suspend:');
        
        const res = await fetch(\`/api/admin/user/\${userId}/suspend\`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ reason, days: days ? parseInt(days) : null })
        });
        if (res.ok) {
          alert('User suspended');
          searchUser();
        } else {
          alert('Failed to suspend user');
        }
      }

      async function banUser(userId) {
        const reason = prompt('Ban reason:');
        if (!reason) return;
        if (!confirm('Permanently ban this user?')) return;
        
        const res = await fetch(\`/api/admin/user/\${userId}/ban\`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ reason })
        });
        if (res.ok) {
          alert('User banned');
          searchUser();
        } else {
          alert('Failed to ban user');
        }
      }

      async function deleteWiki(wikiId, wikiName) {
        if (!confirm(\`Delete wiki "\${wikiName}"?\`)) return;
        
        const res = await fetch(\`/api/admin/wiki/\${wikiId}\`, { method: 'DELETE' });
        if (res.ok) {
          alert('Wiki deleted');
          location.reload();
        } else {
          alert('Failed to delete wiki');
        }
      }
    </script>
  `;
  res.send(renderLayout(`${getText('admin', lang)} Dashboard`, body, null, lang, req));
});

// 管理者API
app.get('/api/admin/stats', ensureAdmin, async (req, res) => {
  try {
    const wikisResult = await pool.query('SELECT COUNT(*) as count FROM wikis WHERE deleted_at IS NULL');
    const pagesResult = await pool.query('SELECT COUNT(*) as count FROM pages WHERE deleted_at IS NULL');
    const usersResult = await pool.query('SELECT COUNT(DISTINCT editor_id) as count FROM revisions');
    const revisionsResult = await pool.query('SELECT COUNT(*) as count FROM revisions');
    
    res.json({ 
      totalWikis: parseInt(wikisResult.rows[0].count),
      totalPages: parseInt(pagesResult.rows[0].count),
      totalUsers: parseInt(usersResult.rows[0].count),
      totalRevisions: parseInt(revisionsResult.rows[0].count)
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/admin/wikis', ensureAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT w.id, w.name, w.address, w.views, w.owner_id, w.created_at
      FROM wikis w 
      WHERE w.deleted_at IS NULL 
      ORDER BY w.views DESC, w.created_at DESC
      LIMIT 50
    `);
    
    res.json({ wikis: result.rows });
  } catch (error) {
    console.error('Admin wikis error:', error);
    res.status(500).json({ error: 'Failed to fetch wikis' });
  }
});

app.get('/api/admin/user/:userId', ensureAdmin, async (req, res) => {
  const { userId } = req.params;
  
  try {
    const warningsResult = await pool.query(
      'SELECT * FROM user_warnings WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    
    const suspensionResult = await pool.query(
      'SELECT * FROM user_suspensions WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 1',
      [userId]
    );
    
    res.json({ 
      warnings: warningsResult.rows, 
      suspension: suspensionResult.rows[0] || null 
    });
  } catch (error) {
    console.error('Admin user error:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

app.post('/api/admin/user/:userId/warn', ensureAdmin, async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body;
  
  if (!reason) return res.status(400).json({ error: 'Reason required' });
  
  try {
    await pool.query(
      'INSERT INTO user_warnings(user_id, reason, issued_by) VALUES ($1, $2, $3)',
      [userId, reason, req.user.id]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Warn user error:', error);
    res.status(500).json({ error: 'Failed to warn user' });
  }
});

app.post('/api/admin/user/:userId/suspend', ensureAdmin, async (req, res) => {
  const { userId } = req.params;
  const { reason, days } = req.body;
  
  if (!reason) return res.status(400).json({ error: 'Reason required' });
  
  let expiresAt = null;
  let type = 'permanent';
  
  if (days && days > 0) {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + days);
    expiresAt = expiry;
    type = 'temporary';
  }
  
  try {
    await pool.query(
      'INSERT INTO user_suspensions(user_id, type, reason, issued_by, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [userId, type, reason, req.user.id, expiresAt]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Suspend user error:', error);
    res.status(500).json({ error: 'Failed to suspend user' });
  }
});

app.post('/api/admin/user/:userId/ban', ensureAdmin, async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body;
  
  if (!reason) return res.status(400).json({ error: 'Reason required' });
  
  try {
    await pool.query(
      'INSERT INTO user_suspensions(user_id, type, reason, issued_by, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [userId, 'permanent', reason, req.user.id, null]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Ban user error:', error);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

app.delete('/api/admin/wiki/:wikiId', ensureAdmin, async (req, res) => {
  const { wikiId } = req.params;
  
  try {
    await pool.query('UPDATE wikis SET deleted_at = NOW() WHERE id = $1', [wikiId]);
    await pool.query('UPDATE pages SET deleted_at = NOW() WHERE wiki_id = $1', [wikiId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete wiki error:', error);
    res.status(500).json({ error: 'Failed to delete wiki' });
  }
});

// 画像アップロード
const imageUpload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 },
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
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ filename: req.file.filename, url: fileUrl, size: req.file.size });
});

// サーバー起動
async function startServer() {
  try {
    await initDatabase();
    
    app.listen(PORT, () => {
      console.log(`🚀 Rec Wiki running on ${BASE_URL}`);
      console.log(`📊 PostgreSQL connected`);
      console.log(`👑 Admin users: ${ADMIN_USERS.join(', ')}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
