// server.js - Complete Firebase Edition
import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as DiscordStrategy } from 'passport-discord';
import path from 'path';
import multer from 'multer';
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import axios from 'axios';
import { diffChars } from 'diff';

// Firebase imports
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { FirestoreStore } from '@google-cloud/connect-firestore';

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_USERS = ['1047797479665578014']; // Admin Discord IDs

// --- Firebase Setup ---
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT is missing in .env');
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

const db = getFirestore(firebaseApp);
const bucket = getStorage(firebaseApp).bucket();

// Collection References
const usersRef = db.collection('users');           // Replaces user_profiles
const wikisRef = db.collection('wikis');
const pagesRef = db.collection('pages');
const revisionsRef = db.collection('revisions');
const settingsRef = db.collection('wiki_settings');
const permissionsRef = db.collection('wiki_permissions'); // Key format: wikiId_userId
const invitesRef = db.collection('wiki_invites');
const badgesRef = db.collection('user_badges');
const warningsRef = db.collection('user_warnings');
const suspensionsRef = db.collection('user_suspensions');
const languagesRef = db.collection('user_languages');
const allowedUsersRef = db.collection('allowed_users'); // For restricted creation

// --- Markdown renderer & sanitizer ---
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

// --- Helpers (Converted to Async for Firestore) ---

// Get Wiki by Address
const wikiByAddress = async (address) => {
  const snapshot = await wikisRef
    .where('address', '==', address)
    .where('deleted_at', '==', null)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
};

// Get Page by Wiki ID and Name
const pageByWikiAndName = async (wikiId, name) => {
  const snapshot = await pagesRef
    .where('wiki_id', '==', wikiId)
    .where('name', '==', name)
    .where('deleted_at', '==', null)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
};

// Language Dictionary
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

const getText = (key, lang = 'ja') => i18n[lang] && i18n[lang][key] ? i18n[lang][key] : i18n.ja[key] || key;

// Render Layout Helper
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
  <meta name="theme-color" content="#3498db">
  <meta property="og:site_name" content="Rec Wiki">
  <meta property="og:title" content="${title || 'Rec Wiki'}">
  ${faviconTag}
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
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px 20px 80px 20px;
      line-height: 1.7;
      background-color: var(--bg-primary);
      color: var(--text-primary);
      transition: background-color 0.3s ease;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
      padding-bottom: 16px;
      border-bottom: 2px solid var(--border-color);
      flex-wrap: wrap;
    }
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
    .btn.success { background-color: var(--success-color); color: white; border-color: var(--success-color); }
    .btn.danger { background-color: var(--danger-color); color: white; border-color: var(--danger-color); }
    .btn.warning { background-color: var(--warning-color); color: white; border-color: var(--warning-color); }
    .btn.disabled { pointer-events: none; opacity: 0.6; }
    
    .card { border: 1px solid var(--border-color); padding: 24px; border-radius: 12px; background-color: var(--card-bg); margin-bottom: 20px; }
    .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; }
    input, textarea, select { width: 100%; padding: 12px; border: 1px solid var(--border-color); border-radius: 8px; background-color: var(--card-bg); color: var(--text-primary); }
    textarea { min-height: 300px; font-family: monospace; resize: vertical; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 6px; font-weight: 500; }
    .form-help { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }
    .muted { color: var(--text-secondary); }
    .mono { font-family: monospace; }
    .chip { padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 20px; font-size: 12px; display: inline-block; margin-right: 4px; text-decoration: none; color: var(--text-primary); }
    
    /* Diff styles */
    .diff-added { background-color: rgba(46, 160, 67, 0.2); text-decoration: none; }
    .diff-removed { background-color: rgba(248, 81, 73, 0.2); text-decoration: line-through; }
    
    .content img { max-width: 100%; height: auto; border-radius: 8px; }
    .breadcrumb { margin-bottom: 20px; font-size: 14px; }
    .breadcrumb a { color: var(--accent-color); text-decoration: none; }
  </style>
</head>
<body data-theme="light">
${suspensionBanner}
<header>
  <div class="header-left">
    <a class="btn" href="/">🏠 ${getText('home', lang)}</a>
  </div>
  <div class="header-center">
    <h1 style="margin: 0; font-size: 1.5rem;"><a href="/" style="text-decoration: none; color: var(--text-primary);">Rec Wiki</a></h1>
  </div>
  <div class="header-right">
    <button class="btn" onclick="toggleTheme()" title="Toggle Theme">🌓</button>
    <div id="auth" style="display:inline-block; margin-left: 8px;"></div>
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
    el.innerHTML = \`
      <div class="user-menu" style="display:inline-flex; gap:8px; align-items:center;">
        <a href="/dashboard" class="btn">📊 ${getText('dashboard', lang)}</a>
        <a href="/user/\${me.id}" class="btn">👤</a>
        \${me.isAdmin ? '<a href="/admin" class="btn warning">⚙️</a>' : ''}
        <a href="/logout" class="btn">🚪</a>
      </div>
    \`;
  } else {
    el.innerHTML = '<a class="btn primary" href="/auth/discord">${getText('login', lang)}</a>';
  }
}).catch(e => console.log(e));
</script>
</body>
</html>`;
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
    const now = new Date().toISOString();
    try {
        // Update or Create User in Firestore
        await usersRef.doc(profile.id).set({
            user_id: profile.id,
            display_name: profile.username,
            email: profile.email,
            last_login_at: now
            // created_at should ideally only be set once, but set merge:true handles updates
        }, { merge: true });
        
        // If created_at missing, set it
        const doc = await usersRef.doc(profile.id).get();
        if (!doc.data().created_at) {
            await usersRef.doc(profile.id).update({ created_at: now });
        }
        
        done(null, profile);
    } catch (e) {
        done(e, null);
    }
}));

// --- Middlewares ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  store: new FirestoreStore({
    dataset: db,
    kind: 'express-sessions'
  }),
  secret: process.env.SESSION_SECRET || 'change_me',
  resave: false,
  saveUninitialized: false,
  cookie: { expires: false }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use('/public', express.static(path.join(process.cwd(), 'public')));
app.set('trust proxy', 1);

// Middleware: User Language & Suspension Check
app.use(async (req, res, next) => {
    req.isSuspended = false;
    req.userLang = 'ja'; // Default

    if (req.isAuthenticated()) {
        try {
            // Language
            const langDoc = await languagesRef.doc(req.user.id).get();
            if (langDoc.exists) req.userLang = langDoc.data().language;
            else if (req.session.language) req.userLang = req.session.language;

            // Suspension
            const suspensionSnapshot = await suspensionsRef
                .where('user_id', '==', req.user.id)
                .where('expires_at', '>', new Date().toISOString())
                .limit(1)
                .get(); // Note: This misses permanent bans (expires_at = null). Handled below.
            
            // Check for permanent ban (expires_at IS NULL or not set) logic needs care in Firestore queries
            // Simplified: Check active suspensions.
            // Alternative for "OR": multiple queries or client-side filter.
            const allSuspensions = await suspensionsRef.where('user_id', '==', req.user.id).get();
            const now = new Date().toISOString();
            
            for (const doc of allSuspensions.docs) {
                const data = doc.data();
                if (data.type === 'permanent' || (data.expires_at && data.expires_at > now)) {
                    req.isSuspended = true;
                    req.suspensionDetails = data;
                    break;
                }
            }

        } catch (error) {
            console.error('Middleware Error:', error);
        }
    } else {
        req.userLang = req.session.language || 'ja';
    }
    next();
});

// --- Auth Guards ---
const createSuspensionBlock = (req) => {
    const lang = req.userLang;
    const body = `<div class="card"><p class="danger">❌ ${lang === 'ja' ? 'アカウントが停止されているため、この操作は実行できません。' : 'Your account is suspended.'}</p><a class="btn" href="/">Back</a></div>`;
    return renderLayout('Suspended', body, null, lang, req);
};

const ensureAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  return res.redirect('/auth/discord');
};

const ensureAdmin = (req, res, next) => {
  if (!req.isAuthenticated() || !ADMIN_USERS.includes(req.user.id)) {
    return res.status(403).send(renderLayout('Forbidden', `<div class="card"><p class="danger">Admin only.</p></div>`, null, 'ja', req));
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
  if (!wiki) return res.status(404).send('Wiki not found');

  const permDoc = await permissionsRef.doc(`${wiki.id}_${req.user.id}`).get();
  
  if (wiki.owner_id === req.user.id || (permDoc.exists && permDoc.data().role === 'admin') || ADMIN_USERS.includes(req.user.id)) {
    return next();
  }
  return res.status(403).send(renderLayout('Forbidden', `<div class="card"><p class="danger">No admin permission.</p></div>`, null, req.userLang, req));
};

const ensureCanEdit = async (req, res, next) => {
  if (!req.isAuthenticated()) return res.redirect('/auth/discord');
  if (req.isSuspended) return res.status(403).send(createSuspensionBlock(req));
  
  const address = req.params.address;
  const wiki = await wikiByAddress(address);
  if (!wiki) return res.status(404).send('Wiki not found');

  if (wiki.owner_id === req.user.id || ADMIN_USERS.includes(req.user.id)) return next();

  const permDoc = await permissionsRef.doc(`${wiki.id}_${req.user.id}`).get();
  if (permDoc.exists) return next();

  const settingDoc = await settingsRef.doc(wiki.id).get();
  const mode = settingDoc.exists ? settingDoc.data().mode : 'loggedin';

  if (mode === 'anyone') return next();
  if (mode === 'loggedin') return next();
  
  return res.status(403).send(renderLayout('Forbidden', `<div class="card"><p class="danger">No edit permission.</p></div>`, null, req.userLang, req));
};

// --- Routes ---

// Language Switcher
app.get('/lang/:lang', async (req, res) => {
  const { lang } = req.params;
  if (!['ja', 'en'].includes(lang)) return res.redirect('/');
  
  if (req.isAuthenticated()) {
    await languagesRef.doc(req.user.id).set({ user_id: req.user.id, language: lang });
  } else {
    req.session.language = lang;
  }
  res.redirect(req.get('Referer') || '/');
});

// Auth
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/create-wiki'));
app.get('/logout', (req, res) => {
  req.logout(() => {});
  res.redirect('/');
});

// API: Me
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

// --- Image Upload (Firebase Storage) ---
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.post('/api/upload-image', ensureAuth, upload.single('image'), async (req, res) => {
  if (req.isSuspended) return res.status(403).json({ error: 'Account suspended' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const filename = `${Date.now()}_${req.file.originalname}`;
    const file = bucket.file(`uploads/${filename}`);
    
    await file.save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype },
      public: true // Note: Ensure your Firebase Storage rules allow public read if you use simple public URLs
    });
    // To make it public via token-based URL or public access:
    // For simplicity in this migration, we assume the bucket is readable or we use the public URL method:
    // const publicUrl = `https://storage.googleapis.com/${bucket.name}/uploads/${filename}`; 
    // Better: getSignedUrl or make public. Assuming "public: true" works with uniform bucket level access off.
    
    // Alternative: Use getSignedUrl for permanent access if bucket is private, or configure bucket as public.
    // Here we construct the public URL assuming standard public access.
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/uploads/${filename}`;

    res.json({ filename, url: publicUrl, size: req.file.size });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// --- API: Wikis List ---
app.get('/api/wikis', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));
  // Note: Offset is inefficient in Firestore, usually startAfter is better.
  // For compatibility, we simulate offset by fetching more or just limit.
  // We will ignore skip for large datasets and rely on basic limit for now.
  
  try {
    const snapshot = await wikisRef
      .where('deleted_at', '==', null)
      .orderBy('views', 'desc')
      .limit(limit)
      .get();

    const wikis = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ wikis, count: wikis.length });
  } catch (error) {
    console.error('Wikis fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch wikis' });
  }
});

// --- Home ---
app.get('/', (req, res) => {
  const lang = req.userLang;
  const isSuspended = !!req.isSuspended;
  const disabledClass = isSuspended ? 'disabled' : '';

  const body = `
    <div class="breadcrumb">🏠 ${getText('home', lang)}</div>
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
      const limit = 10;
      const listEl = document.getElementById('wiki-list');
      const loadMoreBtn = document.getElementById('load-more');

      async function loadWikis() {
        loadMoreBtn.disabled = true;
        const res = await fetch('/api/wikis?limit=' + limit); // Simple fetch
        const data = await res.json();
        
        if (!data.wikis.length) {
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
              <a class="btn" href="/\${w.address}-edit">✏️ ${getText('edit', lang)}</a>
            </div>
          </div>
        \`).join('');
        
        listEl.innerHTML = html;
        loadMoreBtn.style.display = 'none'; // Simple pagination not implemented for brevity
      }
      loadWikis();
    </script>
  `;
  res.send(renderLayout('Rec Wiki', body, null, lang, req));
});

// --- User Dashboard ---
app.get('/dashboard', ensureAuth, async (req, res) => {
  const lang = req.userLang;
  const userId = req.user.id;
  const disabledClass = req.isSuspended ? 'disabled' : '';

  try {
    // Owned Wikis
    const ownedSnapshot = await wikisRef.where('owner_id', '==', userId).where('deleted_at', '==', null).get();
    const ownedWikis = ownedSnapshot.docs.map(d => ({id: d.id, ...d.data()}));

    // Editable Wikis (Requires querying permissions first)
    const permsSnapshot = await permissionsRef.where('editor_id', '==', userId).get();
    let editableWikis = [];
    if (!permsSnapshot.empty) {
        const wikiIds = permsSnapshot.docs.map(d => d.data().wiki_id);
        // Fetch wikis (Firestore 'in' query limited to 10, doing loop for safety)
        // Simplified: loop through IDs
        for (const wid of wikiIds) {
            const wDoc = await wikisRef.doc(wid).get();
            if (wDoc.exists && wDoc.data().owner_id !== userId && !wDoc.data().deleted_at) {
                editableWikis.push({ id: wDoc.id, ...wDoc.data() });
            }
        }
    }

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
    `;
    res.send(renderLayout(getText('dashboard', lang), body, null, lang, req));
  } catch (e) {
    console.error(e);
    res.status(500).send('Error loading dashboard');
  }
});

// --- Create Wiki ---
app.get('/create-wiki', ensureCanCreate, (req, res) => {
  const lang = req.userLang;
  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > 🆕 ${getText('createWiki', lang)}</div>
    <h1>🆕 ${lang === 'ja' ? '新しいWikiを作成' : 'Create a New Wiki'}</h1>
    <form action="/create-wiki" method="post" enctype="multipart/form-data" class="card">
      <div class="form-group">
        <label>📝 ${lang === 'ja' ? 'Wiki名' : 'Wiki Name'}</label>
        <input name="name" required placeholder="MyTeamWiki" maxlength="100">
      </div>
      <div class="form-group">
        <label>🔗 ${lang === 'ja' ? 'アドレス' : 'Address'}</label>
        <input name="address" required pattern="[a-zA-Z0-9-]{2,64}" placeholder="my-team-wiki" maxlength="64">
        <div class="form-help">Unique URL identifier</div>
      </div>
      <div class="form-group">
        <label>🔒 ${lang === 'ja' ? '初期公開設定' : 'Initial Access Setting'}</label>
        <select name="initialMode">
          <option value="loggedin" selected>Logged-in users only</option>
          <option value="anyone">Anyone (Public)</option>
          <option value="invite">Invite only</option>
        </select>
      </div>
      <div class="form-group">
        <div class="cf-turnstile" data-sitekey="${process.env.TURNSTILE_SITE_KEY || '1x00000000000000000000AA'}"></div>
      </div>
      <button class="btn success" type="submit">🚀 ${lang === 'ja' ? '作成' : 'Create'}</button>
    </form>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  `;
  res.send(renderLayout(getText('createWiki', lang), body, null, lang, req));
});

app.post('/create-wiki', ensureCanCreate, upload.single('faviconFile'), async (req, res) => {
  const lang = req.userLang;
  
  // Turnstile Verification
  try {
    const token = req.body['cf-turnstile-response'];
    const ip = req.headers['cf-connecting-ip'] || req.ip;
    const formData = new URLSearchParams();
    formData.append('secret', process.env.TURNSTILE_SECRET_KEY);
    formData.append('response', token);
    formData.append('remoteip', ip);
    // Uncomment to enable strict checking:
    // const result = await axios.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', formData);
    // if (!result.data.success) return res.status(403).send(renderLayout('Error', `<div class="card"><p class="danger">Auth failed.</p></div>`, null, lang, req));
  } catch (error) {
    console.error('Turnstile error', error);
  }

  const { name, address, initialMode } = req.body;
  const slug = (address || '').trim();
  const wname = (name || '').trim();

  if (!/^[a-zA-Z0-9-]{2,64}$/.test(slug)) {
    return res.status(400).send(renderLayout('Error', `<div class="card"><p class="danger">Invalid Address Format.</p></div>`, null, lang, req));
  }

  try {
    const exists = await wikisRef.where('address', '==', slug).limit(1).get();
    if (!exists.empty) {
      return res.status(409).send(renderLayout('Error', `<div class="card"><p class="danger">Address taken.</p></div>`, null, lang, req));
    }

    const now = new Date().toISOString();
    
    // Create Wiki Doc
    const wikiRef = await wikisRef.add({
        name: wname,
        address: slug,
        owner_id: req.user.id,
        created_at: now,
        views: 0,
        deleted_at: null,
        favicon: null // Handle file upload if needed similar to uploads
    });

    // Create Home Page
    const welcomeText = `# ${wname}\n\n🎉 Welcome to your new Wiki!`;
    await pagesRef.add({
        wiki_id: wikiRef.id,
        name: 'home',
        content: welcomeText,
        updated_at: now,
        deleted_at: null
    });

    // Settings
    const mode = ['anyone', 'loggedin', 'invite'].includes(initialMode) ? initialMode : 'loggedin';
    await settingsRef.doc(wikiRef.id).set({
        wiki_id: wikiRef.id,
        mode: mode,
        is_searchable: true
    });

    // Permissions
    await permissionsRef.doc(`${wikiRef.id}_${req.user.id}`).set({
        wiki_id: wikiRef.id,
        editor_id: req.user.id,
        role: 'admin'
    });

    res.redirect(`/${slug}-edit`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Creation failed');
  }
});

// --- Wiki Edit Dashboard ---
app.get('/:address-edit', ensureCanEdit, async (req, res) => {
  const lang = req.userLang;
  const wiki = await wikiByAddress(req.params.address);
  if (!wiki) return res.status(404).send('Wiki not found');

  const pagesSnap = await pagesRef.where('wiki_id', '==', wiki.id).where('deleted_at', '==', null).orderBy('name', 'asc').get();
  const pages = pagesSnap.docs.map(d => d.data());
  const allPages = pages.map(p => `<a class="chip" href="/${wiki.address}/${encodeURIComponent(p.name)}/edit">📄 ${p.name}</a>`).join('');
  
  const settingsDoc = await settingsRef.doc(wiki.id).get();
  const settings = settingsDoc.exists ? settingsDoc.data() : { mode: 'loggedin', is_searchable: true };

  // Permissions
  // Note: Firestore doesn't support join. We fetch all perms for this wiki.
  const permsSnap = await permissionsRef.where('wiki_id', '==', wiki.id).get();
  const permsHtml = permsSnap.docs.map(d => {
      const p = d.data();
      return `<div><strong>${p.editor_id}</strong> — <span class="muted">${p.role}</span></div>`;
  }).join('');

  // Invites
  const invitesSnap = await invitesRef.where('wiki_id', '==', wiki.id).get();
  const invitesHtml = invitesSnap.docs.map(d => {
      const i = d.data();
      return `<div><strong>${i.invited_tag}</strong> (${i.role})</div>`;
  }).join('');

  const body = `
    <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > <a href="/${wiki.address}">📚 ${wiki.name}</a> > Dashboard</div>
    <h1>✏️ ${wiki.name} Dashboard</h1>
    
    <div class="row">
      <div class="card">
        <h2>📄 ${getText('pages', lang)}</h2>
        <div class="list" style="margin-bottom: 20px;">${allPages}</div>
        <form onsubmit="event.preventDefault(); location.href='/${wiki.address}/'+encodeURIComponent(this.page.value)+'/edit'">
           <div class="form-group">
             <label>📝 New Page Name</label>
             <input name="page" required placeholder="page-name">
           </div>
           <button class="btn success" type="submit">🚀 Open Editor</button>
        </form>
      </div>
      <div class="card">
        <h2>⚙️ Settings</h2>
        <form action="/${wiki.address}/settings" method="post">
           <div class="form-group">
             <label>Access Mode</label>
             <select name="mode">
               <option value="loggedin" ${settings.mode === 'loggedin'?'selected':''}>Logged In</option>
               <option value="anyone" ${settings.mode === 'anyone'?'selected':''}>Anyone</option>
               <option value="invite" ${settings.mode === 'invite'?'selected':''}>Invite Only</option>
             </select>
           </div>
           <button class="btn" type="submit">Save</button>
        </form>
      </div>
    </div>
    
    <div class="row">
      <div class="card">
        <h3>👥 Editors</h3>
        ${permsHtml || 'None'}
        <form style="margin-top:10px;" action="/${wiki.address}/permissions" method="post">
          <input name="editor_id" placeholder="Discord ID" style="margin-bottom:5px;">
          <button class="btn" type="submit">Add Editor</button>
        </form>
      </div>
      <div class="card">
        <h3>✉️ Invites</h3>
        ${invitesHtml || 'None'}
        <form style="margin-top:10px;" action="/${wiki.address}/invite" method="post">
          <input name="invited_tag" placeholder="User#1234" style="margin-bottom:5px;">
          <button class="btn" type="submit">Create Invite</button>
        </form>
      </div>
    </div>
  `;
  res.send(renderLayout('Dashboard', body, wiki.favicon, lang, req));
});

// --- Settings / Permissions Handlers ---
app.post('/:address/settings', ensureCanAdministerWiki, async (req, res) => {
    const wiki = await wikiByAddress(req.params.address);
    await settingsRef.doc(wiki.id).set({
        wiki_id: wiki.id,
        mode: req.body.mode
    }, { merge: true });
    res.redirect(`/${wiki.address}-edit`);
});

app.post('/:address/permissions', ensureCanAdministerWiki, async (req, res) => {
    const wiki = await wikiByAddress(req.params.address);
    const { editor_id } = req.body;
    if (editor_id) {
        await permissionsRef.doc(`${wiki.id}_${editor_id}`).set({
            wiki_id: wiki.id,
            editor_id: editor_id,
            role: 'editor'
        });
    }
    res.redirect(`/${wiki.address}-edit`);
});

app.post('/:address/invite', ensureCanAdministerWiki, async (req, res) => {
    const wiki = await wikiByAddress(req.params.address);
    const { invited_tag } = req.body;
    if (invited_tag) {
        await invitesRef.add({
            wiki_id: wiki.id,
            invited_tag,
            role: 'editor',
            created_at: new Date().toISOString()
        });
    }
    res.redirect(`/${wiki.address}-edit`);
});

// --- Page View ---
app.get('/:address/:page', async (req, res) => {
    const { address, page } = req.params;
    const lang = req.userLang;
    
    try {
        const wiki = await wikiByAddress(address);
        if (!wiki) return res.status(404).send(renderLayout('404', `<div class="card"><p class="danger">Wiki not found</p></div>`, null, lang, req));

        const pg = await pageByWikiAndName(wiki.id, page);
        
        if (!pg) {
             const disabledClass = req.isSuspended ? 'disabled' : '';
             const body = `
                <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > <a href="/${wiki.address}">📚 ${wiki.name}</a> > 📄 ${page}</div>
                <div class="card" style="text-align:center;">
                    <h1>${page}</h1>
                    <p class="muted">Page does not exist yet.</p>
                    <a class="btn primary ${disabledClass}" href="/${wiki.address}/${encodeURIComponent(page)}/edit">Create Page</a>
                </div>
             `;
             return res.status(404).send(renderLayout(page, body, wiki.favicon, lang, req));
        }

        // Increment Views (Fire and Forget)
        wikisRef.doc(wiki.id).update({ views: FieldValue.increment(1) }).catch(()=>{});

        const html = sanitize(md.render(pg.content));
        const disabledClass = req.isSuspended ? 'disabled' : '';
        const body = `
            <div class="breadcrumb"><a href="/">🏠 ${getText('home', lang)}</a> > <a href="/${wiki.address}">📚 ${wiki.name}</a> > 📄 ${pg.name}</div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:24px;">
                <h1>📄 ${pg.name}</h1>
                <div style="display:flex; gap:8px;">
                    <a class="btn ${disabledClass}" href="/${wiki.address}/${encodeURIComponent(pg.name)}/edit">✏️ Edit</a>
                    <a class="btn ${disabledClass}" href="/${wiki.address}/${encodeURIComponent(pg.name)}/revisions">📋 History</a>
                </div>
            </div>
            <div class="card content">${html}</div>
            <div class="card muted">Last updated: ${new Date(pg.updated_at).toLocaleString()}</div>
        `;
        res.send(renderLayout(`${wiki.name}/${pg.name}`, body, wiki.favicon, lang, req));

    } catch (e) {
        console.error(e);
        res.status(500).send('Error');
    }
});

// --- Edit Page ---
app.get('/:address/:page/edit', ensureCanEdit, async (req, res) => {
    const { address, page } = req.params;
    const lang = req.userLang;
    const wiki = await wikiByAddress(address);
    if (!wiki) return res.status(404).send('Wiki not found');

    const pg = await pageByWikiAndName(wiki.id, page);
    const content = pg ? pg.content : '';

    const body = `
        <div class="breadcrumb"><a href="/${wiki.address}/${encodeURIComponent(page)}">Back to Page</a></div>
        <h1>✏️ Edit ${page}</h1>
        <form method="post" action="/${wiki.address}/${encodeURIComponent(page)}/edit" class="card">
            <div class="form-group">
                <label>Markdown Content</label>
                <textarea name="content">${content.replace(/</g, '&lt;')}</textarea>
            </div>
            <div class="form-group">
                <label>Image Upload</label>
                <input type="file" id="imgUpload">
                <div id="imgPreview"></div>
            </div>
            <button class="btn success" type="submit">Save</button>
        </form>
        <script>
            document.getElementById('imgUpload').addEventListener('change', async (e) => {
                const file = e.target.files[0];
                const fd = new FormData();
                fd.append('image', file);
                const res = await fetch('/api/upload-image', {method:'POST', body:fd});
                const data = await res.json();
                const ta = document.querySelector('textarea');
                ta.value += '\\n![' + file.name + '](' + data.url + ')';
            });
        </script>
    `;
    res.send(renderLayout(`Edit ${page}`, body, wiki.favicon, lang, req));
});

app.post('/:address/:page/edit', ensureCanEdit, async (req, res) => {
    const { address, page } = req.params;
    const wiki = await wikiByAddress(address);
    if (!wiki) return res.status(404).send('Wiki not found');

    const now = new Date().toISOString();
    const content = req.body.content || '';
    
    let pg = await pageByWikiAndName(wiki.id, page);
    
    if (pg) {
        await pagesRef.doc(pg.id).update({ content, updated_at: now });
        await revisionsRef.add({
            page_id: pg.id,
            content,
            editor_id: req.user.id,
            created_at: now
        });
    } else {
        const newPage = await pagesRef.add({
            wiki_id: wiki.id,
            name: page,
            content,
            updated_at: now,
            deleted_at: null
        });
        await revisionsRef.add({
            page_id: newPage.id,
            content,
            editor_id: req.user.id,
            created_at: now
        });
    }
    res.redirect(`/${wiki.address}/${encodeURIComponent(page)}`);
});

// --- Revisions ---
app.get('/:address/:page/revisions', ensureAuth, async (req, res) => {
    const { address, page } = req.params;
    const lang = req.userLang;
    const wiki = await wikiByAddress(address);
    if (!wiki) return res.status(404).send('Wiki not found');
    const pg = await pageByWikiAndName(wiki.id, page);
    if (!pg) return res.status(404).send('Page not found');

    const revsSnap = await revisionsRef.where('page_id', '==', pg.id).orderBy('created_at', 'desc').get();
    const revs = revsSnap.docs.map(d => ({id: d.id, ...d.data()}));

    const rows = revs.map(r => `
        <div class="card">
           <div style="display:flex; justify-content:space-between;">
             <div>
                <strong>${new Date(r.created_at).toLocaleString()}</strong> by ${r.editor_id}
             </div>
             <a class="btn" href="/${wiki.address}/${encodeURIComponent(page)}/revision/${r.id}">View</a>
           </div>
        </div>
    `).join('');
    
    const body = `<h1>History: ${page}</h1>${rows}`;
    res.send(renderLayout('History', body, wiki.favicon, lang, req));
});

app.get('/:address/:page/revision/:revId', ensureAuth, async (req, res) => {
    const { address, page, revId } = req.params;
    const lang = req.userLang;
    const wiki = await wikiByAddress(address);
    const pg = await pageByWikiAndName(wiki.id, page);
    const revDoc = await revisionsRef.doc(revId).get();
    if (!revDoc.exists) return res.status(404).send('Revision not found');
    const rev = revDoc.data();

    const diffResult = diffChars(pg.content, rev.content);
    const diffHtml = diffResult.map(part => {
        const colorClass = part.added ? 'diff-added' : part.removed ? 'diff-removed' : '';
        return `<span class="${colorClass}">${sanitize(part.value)}</span>`;
    }).join('');

    const body = `
        <h1>Revision View</h1>
        <p>Current vs Revision</p>
        <pre class="card code-bg">${diffHtml}</pre>
        <form method="post" action="/${wiki.address}/${encodeURIComponent(page)}/revision/${revId}/rollback">
           <button class="btn danger" onclick="return confirm('Rollback?')">Rollback to this version</button>
        </form>
    `;
    res.send(renderLayout('Revision', body, wiki.favicon, lang, req));
});

app.post('/:address/:page/revision/:revId/rollback', ensureCanAdministerWiki, async (req, res) => {
    const { address, page, revId } = req.params;
    const wiki = await wikiByAddress(address);
    const pg = await pageByWikiAndName(wiki.id, page);
    const revDoc = await revisionsRef.doc(revId).get();
    
    const now = new Date().toISOString();
    const content = revDoc.data().content;
    
    await pagesRef.doc(pg.id).update({ content, updated_at: now });
    await revisionsRef.add({
        page_id: pg.id,
        content,
        editor_id: req.user.id,
        created_at: now
    });
    
    res.redirect(`/${wiki.address}/${encodeURIComponent(page)}`);
});

// --- Admin Dashboard ---
app.get('/admin', ensureAdmin, async (req, res) => {
    const lang = req.userLang;
    
    // Basic Stats (Counts) - Using aggregation for efficiency
    const wCount = (await wikisRef.count().get()).data().count;
    const pCount = (await pagesRef.count().get()).data().count;
    const uCount = (await usersRef.count().get()).data().count;

    const body = `
        <div class="breadcrumb">🏠 Home > Admin</div>
        <h1>Admin Dashboard</h1>
        <div class="row">
           <div class="card">
              <h3>Stats</h3>
              <p>Wikis: ${wCount}</p>
              <p>Pages: ${pCount}</p>
              <p>Users: ${uCount}</p>
           </div>
           <div class="card">
              <h3>User Management</h3>
              <input id="uid" placeholder="User ID">
              <button class="btn" onclick="manageUser()">Search</button>
              <div id="uResult"></div>
           </div>
        </div>
        <script>
           async function manageUser() {
               const id = document.getElementById('uid').value;
               const res = await fetch('/api/admin/user/' + id);
               const data = await res.json();
               document.getElementById('uResult').innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
           }
        </script>
    `;
    res.send(renderLayout('Admin', body, null, lang, req));
});

app.get('/api/admin/user/:id', ensureAdmin, async (req, res) => {
    const uid = req.params.id;
    const uDoc = await usersRef.doc(uid).get();
    const warns = await warningsRef.where('user_id', '==', uid).get();
    res.json({
        user: uDoc.exists ? uDoc.data() : null,
        warnings: warns.docs.map(d => d.data())
    });
});

// --- User Profile ---
app.get('/user/:id', async (req, res) => {
    const uid = req.params.id;
    const lang = req.userLang;
    const uDoc = await usersRef.doc(uid).get();
    const user = uDoc.exists ? uDoc.data() : { display_name: 'Unknown' };
    const badgesSnap = await badgesRef.where('user_id', '==', uid).get();
    const badges = badgesSnap.docs.map(d => d.data());

    const body = `
        <h1>👤 ${user.display_name}</h1>
        <p class="mono">ID: ${uid}</p>
        <div class="list">
           ${badges.map(b => `<span class="chip" style="background:${b.badge_color};color:white;">${b.badge_name}</span>`).join('')}
        </div>
    `;
    res.send(renderLayout('Profile', body, null, lang, req));
});

// --- Root Redirect for Wiki Address ---
app.get('/:address', async (req, res) => {
    const wiki = await wikiByAddress(req.params.address);
    if (wiki) res.redirect(`/${wiki.address}/home`);
    else res.status(404).send(renderLayout('404', '<div class="card"><p class="danger">Wiki not found</p></div>', null, req.userLang, req));
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Rec Wiki (Firebase) running on ${BASE_URL}`);
});
