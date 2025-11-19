import Database from 'better-sqlite3';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import 'dotenv/config';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const firebaseApp = initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore(firebaseApp);
const sqliteDb = new Database('./data/wiki.db');

async function migrate() {
  console.log('🚀 Starting migration...');
  
  // ユーザー移行
  const users = sqliteDb.prepare('SELECT * FROM user_profiles').all();
  for (const user of users) {
    await db.collection('users').doc(user.user_id).set({
      user_id: user.user_id,
      display_name: user.display_name,
      email: user.email,
      created_at: user.created_at || new Date().toISOString()
    });
  }
  console.log(`✅ Migrated ${users.length} users`);
  
  // Wiki移行
  const wikis = sqliteDb.prepare('SELECT * FROM wikis WHERE deleted_at IS NULL').all();
  const wikiIdMap = {};
  for (const wiki of wikis) {
    const wikiRef = await db.collection('wikis').add({
      name: wiki.name,
      address: wiki.address,
      favicon: wiki.favicon,
      owner_id: wiki.owner_id,
      created_at: wiki.created_at,
      views: wiki.views || 0,
      deleted_at: null
    });
    wikiIdMap[wiki.id] = wikiRef.id;
  }
  console.log(`✅ Migrated ${wikis.length} wikis`);
  
  // ページ移行
  const pages = sqliteDb.prepare('SELECT * FROM pages WHERE deleted_at IS NULL').all();
  const pageIdMap = {};
  for (const page of pages) {
    const newWikiId = wikiIdMap[page.wiki_id];
    if (!newWikiId) continue;
    
    const pageRef = await db.collection('pages').add({
      wiki_id: newWikiId,
      name: page.name,
      content: page.content,
      updated_at: page.updated_at,
      deleted_at: null
    });
    pageIdMap[page.id] = pageRef.id;
  }
  console.log(`✅ Migrated ${pages.length} pages`);
  
  // リビジョン移行
  const revisions = sqliteDb.prepare('SELECT * FROM revisions').all();
  for (const revision of revisions) {
    const newPageId = pageIdMap[revision.page_id];
    if (!newPageId) continue;
    
    await db.collection('revisions').add({
      page_id: newPageId,
      content: revision.content,
      editor_id: revision.editor_id,
      created_at: revision.created_at
    });
  }
  console.log(`✅ Migrated ${revisions.length} revisions`);
  
  // Wiki設定移行
  const settings = sqliteDb.prepare('SELECT * FROM wiki_settings').all();
  for (const setting of settings) {
    const newWikiId = wikiIdMap[setting.wiki_id];
    if (!newWikiId) continue;
    
    await db.collection('wiki_settings').doc(newWikiId).set({
      wiki_id: newWikiId,
      mode: setting.mode || 'loggedin',
      is_searchable: setting.is_searchable !== 0
    });
  }
  console.log(`✅ Migrated ${settings.length} settings`);
  
  console.log('🎉 Migration completed!');
  process.exit(0);
}

migrate().catch(console.error);
