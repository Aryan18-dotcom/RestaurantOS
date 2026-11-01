import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import { Server } from 'socket.io';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const RESTAURANT = process.env.RESTAURANT_NAME || 'Maison Table';
const TAX_RATE = Math.max(0, Number(process.env.TAX_RATE ?? 5));
const PUBLIC_URL = (() => {
  const configuredUrl=String(process.env.PUBLIC_URL||'').trim();
  if(!configuredUrl)return '';
  let url;
  try{url=new URL(configuredUrl)}catch{throw new Error('PUBLIC_URL must be a valid absolute URL, such as https://orders.example.com.')}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('PUBLIC_URL must contain only an http(s) origin, such as https://orders.example.com.');
  if(url.protocol!=='https:')console.warn('[PUBLIC_URL] HTTPS is strongly recommended for customer access over the internet.');
  return url.origin;
})();
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const db = new Database(path.join(dataDir, 'restaurant.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS tables (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, capacity INTEGER NOT NULL DEFAULT 4, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS menu_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL, description TEXT DEFAULT '', price REAL NOT NULL CHECK(price >= 0), image TEXT DEFAULT '', available INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL REFERENCES tables(id), status TEXT NOT NULL DEFAULT 'open', opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at TEXT);
CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id), table_id INTEGER NOT NULL REFERENCES tables(id), source TEXT NOT NULL DEFAULT 'customer', status TEXT NOT NULL DEFAULT 'new', customer_note TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), menu_item_id INTEGER REFERENCES menu_items(id), item_name TEXT NOT NULL, unit_price REAL NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0), notes TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'new');
CREATE TABLE IF NOT EXISTS bills (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id), invoice_no TEXT NOT NULL UNIQUE, subtotal REAL NOT NULL, tax_rate REAL NOT NULL, tax_amount REAL NOT NULL, total REAL NOT NULL, paid_amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, bill_id INTEGER NOT NULL REFERENCES bills(id), method TEXT NOT NULL, amount REAL NOT NULL CHECK(amount > 0), reference TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS customer_contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL UNIQUE, whatsapp_opt_in INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS ebill_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id), contact_id INTEGER NOT NULL REFERENCES customer_contacts(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS broadcasts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, sent_at TEXT);
CREATE TABLE IF NOT EXISTS broadcast_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id), contact_id INTEGER NOT NULL REFERENCES customer_contacts(id), status TEXT NOT NULL, provider_message_id TEXT DEFAULT '', error TEXT DEFAULT '', sent_at TEXT);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pickup_tokens (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_users (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL UNIQUE, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_changed_at INTEGER NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0, must_change_username INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS auth_login_attempts (attempt_key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, window_started_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_auth_login_attempts_window ON auth_login_attempts(window_started_at);
`);

// Forward-compatible migrations for existing trial databases.
const ensureColumn = (table, column, definition) => { const cols=db.prepare(`PRAGMA table_info(${table})`).all(); if(!cols.some(c=>c.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); };
ensureColumn('orders','order_type',"TEXT NOT NULL DEFAULT 'dine_in'");
ensureColumn('orders','customer_name',"TEXT NOT NULL DEFAULT ''");
ensureColumn('orders','customer_phone',"TEXT NOT NULL DEFAULT ''");
ensureColumn('bills','customer_name',"TEXT NOT NULL DEFAULT ''");
ensureColumn('bills','customer_phone',"TEXT NOT NULL DEFAULT ''");
ensureColumn('bills','ebill_sent_at','TEXT');
ensureColumn('payments','customer_name',"TEXT NOT NULL DEFAULT ''");
ensureColumn('payments','customer_phone',"TEXT NOT NULL DEFAULT ''");
db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('auto_send_ebill','off')").run();
const scryptAsync = promisify(crypto.scrypt);
const SESSION_COOKIE = 'restaurantos_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;
const passwordSeedDefaults = [
  { role:'owner', username:'owner', password:'12345', mustChangePassword:true, mustChangeUsername:true },
  { role:'kitchen', username:'kitchen', password:'12345' },
  { role:'waiter', username:'waiter', password:'12345' },
  { role:'super-admin', username:'super-admin', password:'admin@pass123', mustChangePassword:true }
];
async function hashPassword(password) {
  const salt=crypto.randomBytes(16);
  const hash=await scryptAsync(password,salt,64,{N:32768,r:8,p:1,maxmem:128*1024*1024});
  return `scrypt$32768$8$1$${salt.toString('hex')}$${Buffer.from(hash).toString('hex')}`;
}
async function verifyPassword(password,encoded) {
  const [algorithm,n,r,p,saltHex,hashHex]=String(encoded).split('$');
  if(algorithm!=='scrypt'||!saltHex||!hashHex)return false;
  const expected=Buffer.from(hashHex,'hex');
  const actual=Buffer.from(await scryptAsync(password,Buffer.from(saltHex,'hex'),expected.length,{N:Number(n),r:Number(r),p:Number(p),maxmem:128*1024*1024}));
  return expected.length===actual.length&&crypto.timingSafeEqual(expected,actual);
}
const DUMMY_PASSWORD_HASH=await hashPassword(crypto.randomBytes(32).toString('hex'));
for(const account of passwordSeedDefaults){
  if(!db.prepare('SELECT id FROM auth_users WHERE role=?').get(account.role)){
    const now=Date.now();
    db.prepare('INSERT INTO auth_users(role,username,password_hash,password_changed_at,must_change_password,must_change_username) VALUES(?,?,?,?,?,?)')
      .run(account.role,account.username,await hashPassword(account.password),now,account.mustChangePassword?1:0,account.mustChangeUsername?1:0);
    console.warn(`[Authentication] Initialized default ${account.role} account. Change the default credentials as required on first login.`);
  }
}
const menuCount = db.prepare('SELECT COUNT(*) n FROM menu_items').get().n;
if (!menuCount) {
  const seed = db.prepare('INSERT INTO menu_items(name,category,description,price,image,available) VALUES(?,?,?,?,?,1)');
  const foods = [
    ['Truffle Mushroom Pizza','Mains','Wood-fired pizza, wild mushrooms, mozzarella and herbs',389,'https://images.unsplash.com/photo-1579751626657-72bc17010498?auto=format&fit=crop&w=900&q=85'],
    ['Classic Margherita','Mains','San Marzano tomato, basil and fresh mozzarella',299,'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?auto=format&fit=crop&w=900&q=85'],
    ['Creamy Alfredo Pasta','Mains','Silky parmesan cream, cracked pepper and parsley',329,'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?auto=format&fit=crop&w=900&q=85'],
    ['Crispy Garden Salad','Starters','Seasonal greens, cucumber, cherry tomato and citrus',189,'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=900&q=85'],
    ['Loaded Fries','Starters','Golden fries with house seasoning and creamy dip',159,'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?auto=format&fit=crop&w=900&q=85'],
    ['Chocolate Lava Cake','Desserts','Warm chocolate cake with a molten centre',179,'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?auto=format&fit=crop&w=900&q=85'],
    ['Mango Cheesecake','Desserts','Creamy cheesecake with mango compote',199,'https://images.unsplash.com/photo-1533134242443-d4fd215305ad?auto=format&fit=crop&w=900&q=85'],
    ['Cold Coffee','Drinks','Chilled coffee, milk and a touch of sweetness',129,'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=900&q=85'],
    ['Fresh Lime Soda','Drinks','Fresh lime, soda and mint; sweet or salted',89,'https://images.unsplash.com/photo-1513558161293-cdaf765edfd7?auto=format&fit=crop&w=900&q=85']
  ];
  const tx = db.transaction(() => foods.forEach(f => seed.run(...f))); tx();
}
if (!db.prepare('SELECT COUNT(*) n FROM tables').get().n) {
  const add = db.prepare('INSERT INTO tables(name,capacity) VALUES(?,?)');
  const tx = db.transaction(() => { for (let i=1;i<=8;i++) add.run(`Table ${i}`, i <= 2 ? 2 : 4); }); tx();
}

db.prepare("INSERT OR IGNORE INTO tables(name,capacity) VALUES('Pickup Orders',1)").run();
const pickupTableId=db.prepare("SELECT id FROM tables WHERE name='Pickup Orders'").get().id;
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.set('trust proxy',process.env.TRUST_PROXY==='1'?1:false);
app.use((req,res,next)=>{ res.setHeader('X-Content-Type-Options','nosniff'); next(); });
function parseCookies(header='') { return Object.fromEntries(header.split(';').map(part=>part.trim().split(/=(.*)/s).slice(0,2)).filter(([key,value])=>key&&value!==undefined)); }
function validRequestOrigin(req) {
  const origin=req.get('origin');
  if(!origin)return true;
  try{
    const parsed=new URL(origin);
    const allowedHosts=new Set([req.get('host')]);
    if(PUBLIC_URL)allowedHosts.add(new URL(PUBLIC_URL).host);
    return allowedHosts.has(parsed.host)&&(!req.secure||parsed.protocol==='https:');
  }catch{return false}
}
function getSession(token) {
  if(!token)return null;
  const tokenHash=crypto.createHash('sha256').update(token).digest('hex');
  const row=db.prepare(`SELECT s.token_hash,s.csrf_token,s.expires_at,u.id user_id,u.role,u.username,u.password_changed_at,u.must_change_password,u.must_change_username FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(tokenHash,Date.now());
  if(!row)return null;
  return {...row,mustChangePassword:!!row.must_change_password||(row.role==='super-admin'&&Date.now()-row.password_changed_at>=PASSWORD_MAX_AGE_MS),mustChangeUsername:!!row.must_change_username};
}
app.use((req,_res,next)=>{
  const token=parseCookies(req.headers.cookie)[SESSION_COOKIE];
  req.authSession=getSession(token);
  req.authToken=token||'';
  req.authUser=req.authSession?{id:req.authSession.user_id,role:req.authSession.role,username:req.authSession.username,mustChangePassword:req.authSession.mustChangePassword,mustChangeUsername:req.authSession.mustChangeUsername}:null;
  next();
});
app.use('/api',(req,res,next)=>{
  if(req.path.startsWith('/auth/'))return next();
  if(req.authUser?.mustChangePassword)return res.status(428).json({error:'Change your password before continuing.',mustChangePassword:true});
  if(req.authSession&&!['GET','HEAD','OPTIONS'].includes(req.method)&&!csrfValid(req))return res.status(403).json({error:'Security token is missing or invalid. Reload the page and try again.'});
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
function role(req) { return req.authUser?.role || 'customer'; }
function csrfValid(req) {
  const supplied=String(req.headers['x-csrf-token']||'');
  const expected=req.authSession?.csrf_token||'';
  const a=Buffer.from(supplied),b=Buffer.from(expected);
  return a.length>0&&a.length===b.length&&crypto.timingSafeEqual(a,b);
}
function setSessionCookie(req,res,token) {
  const flags=['Path=/','HttpOnly','SameSite=Lax',`Max-Age=${Math.floor(SESSION_DURATION_MS/1000)}`];
  if(req.secure)flags.push('Secure');
  res.setHeader('Set-Cookie',`${SESSION_COOKIE}=${encodeURIComponent(token)}; ${flags.join('; ')}`);
}
function clearSessionCookie(res) { res.setHeader('Set-Cookie',`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }
function createSession(userId) {
  const token=crypto.randomBytes(32).toString('base64url');
  const csrfToken=crypto.randomBytes(32).toString('base64url');
  const expiresAt=Date.now()+SESSION_DURATION_MS;
  db.prepare('INSERT INTO auth_sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)')
    .run(crypto.createHash('sha256').update(token).digest('hex'),userId,csrfToken,expiresAt);
  return {token,csrfToken,expiresAt};
}
function allow(...allowed) {
  return (req,res,next) => {
    if(!req.authUser)return res.status(401).json({error:'Sign in to continue.'});
    if(req.authUser.mustChangePassword)return res.status(428).json({error:'Change your password before continuing.',mustChangePassword:true});
    if(!allowed.includes(role(req)))return res.status(403).json({error:'This role is not permitted to perform that action.'});
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!csrfValid(req))return res.status(403).json({error:'Security token is missing or invalid. Reload the page and try again.'});
    next();
  };
}
function asyncRoute(handler) { return (req,res,next)=>Promise.resolve(handler(req,res,next)).catch(next); }
const loginWindowMs=15*60*1000;
const maxLoginFailures=5;
const maxIpLoginFailures=20;
function loginAttemptKey(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function getLoginAttempt(key,now) {
  const row=db.prepare('SELECT attempts,window_started_at FROM auth_login_attempts WHERE attempt_key=?').get(key);
  return row&&now-row.window_started_at<loginWindowMs?row:null;
}
function recordLoginFailure(key,now) {
  const attempt=getLoginAttempt(key,now);
  if(attempt)db.prepare('UPDATE auth_login_attempts SET attempts=attempts+1 WHERE attempt_key=?').run(key);
  else db.prepare('INSERT INTO auth_login_attempts(attempt_key,attempts,window_started_at) VALUES(?,1,?) ON CONFLICT(attempt_key) DO UPDATE SET attempts=1,window_started_at=excluded.window_started_at').run(key,now);
}
function authAccount(user) {
  return {role:user.role,username:user.username,mustChangePassword:user.mustChangePassword,mustChangeUsername:user.mustChangeUsername,passwordExpiresAt:user.role==='super-admin'?user.password_changed_at+PASSWORD_MAX_AGE_MS:null,csrfToken:user.csrf_token};
}
app.post('/api/auth/login',asyncRoute(async(req,res)=>{
  if(!validRequestOrigin(req))return res.status(403).json({error:'Request origin is not allowed.'});
  const username=String(req.body.username||'').trim().toLowerCase().slice(0,40),password=String(req.body.password||'');
  const now=Date.now(),userKey=loginAttemptKey(`user:${req.ip}:${username}`),ipKey=loginAttemptKey(`ip:${req.ip}`);
  db.prepare('DELETE FROM auth_login_attempts WHERE window_started_at<=?').run(now-loginWindowMs);
  const userAttempt=getLoginAttempt(userKey,now),ipAttempt=getLoginAttempt(ipKey,now);
  if(userAttempt?.attempts>=maxLoginFailures||ipAttempt?.attempts>=maxIpLoginFailures)return res.status(429).json({error:'Too many sign-in attempts. Try again in 15 minutes.'});
  const user=db.prepare('SELECT * FROM auth_users WHERE username=?').get(username);
  const passwordMatches=await verifyPassword(password.length<=256?password:'',user?.password_hash||DUMMY_PASSWORD_HASH);
  if(!user||password.length>256||!passwordMatches){
    recordLoginFailure(userKey,now);
    recordLoginFailure(ipKey,now);
    return res.status(401).json({error:'Username or password is incorrect.'});
  }
  db.prepare('DELETE FROM auth_login_attempts WHERE attempt_key IN (?,?)').run(userKey,ipKey);
  db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(now);
  const session=createSession(user.id);
  setSessionCookie(req,res,session.token);
  const authenticated={...user,mustChangePassword:!!user.must_change_password||(user.role==='super-admin'&&now-user.password_changed_at>=PASSWORD_MAX_AGE_MS),mustChangeUsername:!!user.must_change_username,csrf_token:session.csrfToken};
  res.setHeader('Cache-Control','no-store');
  res.json({account:authAccount(authenticated)});
}));
app.get('/api/auth/me',(req,res)=>{
  if(!req.authSession)return res.status(401).json({error:'Sign in to continue.'});
  res.setHeader('Cache-Control','no-store');
  res.json({account:authAccount(req.authSession)});
});
app.post('/api/auth/logout',(req,res)=>{
  if(req.authSession&&!csrfValid(req))return res.status(403).json({error:'Security token is missing or invalid.'});
  if(req.authSession)db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(req.authSession.token_hash);
  clearSessionCookie(res);
  res.json({ok:true});
});
app.post('/api/auth/change-password',asyncRoute(async(req,res)=>{
  if(!req.authSession)return res.status(401).json({error:'Sign in to continue.'});
  if(!csrfValid(req))return res.status(403).json({error:'Security token is missing or invalid.'});
  const currentPassword=String(req.body.currentPassword||''),newPassword=String(req.body.newPassword||'');
  const requestedUsername=String(req.body.username||'').trim().toLowerCase();
  const user=db.prepare('SELECT * FROM auth_users WHERE id=?').get(req.authSession.user_id);
  if(!await verifyPassword(currentPassword,user.password_hash))return res.status(400).json({error:'Current password is incorrect.'});
  if(newPassword.length<12||newPassword.length>256)return res.status(400).json({error:'New password must be between 12 and 256 characters.'});
  if(await verifyPassword(newPassword,user.password_hash))return res.status(400).json({error:'Choose a password different from your current password.'});
  if(user.must_change_username&&!requestedUsername)return res.status(400).json({error:'Choose a new username as well as a new password.'});
  const username=requestedUsername||user.username;
  if(!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username))return res.status(400).json({error:'Username must be 3–40 characters using letters, numbers, dots, underscores or hyphens.'});
  if(user.must_change_username&&username===user.username)return res.status(400).json({error:'Choose a username different from the default.'});
  if(db.prepare('SELECT id FROM auth_users WHERE username=? AND id<>?').get(username,user.id))return res.status(409).json({error:'That username is already in use.'});
  const passwordHash=await hashPassword(newPassword),now=Date.now();
  const nextSessionToken=crypto.randomBytes(32).toString('base64url'),csrfToken=crypto.randomBytes(32).toString('base64url'),expiresAt=now+SESSION_DURATION_MS;
  const nextTokenHash=crypto.createHash('sha256').update(nextSessionToken).digest('hex');
  const tx=db.transaction(()=>{
    db.prepare('UPDATE auth_users SET username=?,password_hash=?,password_changed_at=?,must_change_password=0,must_change_username=0 WHERE id=?').run(username,passwordHash,now,user.id);
    db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(user.id);
    db.prepare('INSERT INTO auth_sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)').run(nextTokenHash,user.id,csrfToken,expiresAt);
  });
  tx();
  setSessionCookie(req,res,nextSessionToken);
  res.json({account:{role:user.role,username,mustChangePassword:false,mustChangeUsername:false,passwordExpiresAt:user.role==='super-admin'?now+PASSWORD_MAX_AGE_MS:null,csrfToken}});
}));
io.use((socket,next)=>{
  const origin=socket.handshake.headers.origin,host=socket.handshake.headers.host;
  if(origin){try{const originHost=new URL(origin).host;if(originHost!==host&&(!PUBLIC_URL||originHost!==new URL(PUBLIC_URL).host))return next(new Error('Socket origin is not allowed.'))}catch{return next(new Error('Socket origin is not allowed.'))}}
  const token=parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE];
  const session=getSession(token);
  if(session&&!session.mustChangePassword)socket.data.authUser={id:session.user_id,role:session.role};
  next();
});
function audit(event) { db.prepare('INSERT INTO audit_events(event_type) VALUES(?)').run(event); }
function broadcast(event, data={}) {
  for(const socket of io.sockets.sockets.values()){
    const authenticatedRoles=new Set(['owner','waiter','kitchen','super-admin']);
    const payload=authenticatedRoles.has(socket.data.authUser?.role)?data:
      event==='billing:updated'?{tableId:data.tableId,status:data.status,sessionId:data.sessionId}:
      event==='orders:updated'?{tableId:data.tableId}:{};
    socket.emit(event,payload);
  }
}
function activeSession(tableId) { return db.prepare("SELECT * FROM sessions WHERE table_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(tableId); }
function sessionSummary(sessionId) {
  const session = db.prepare(`SELECT s.*, t.name table_name FROM sessions s JOIN tables t ON t.id=s.table_id WHERE s.id=?`).get(sessionId);
  if (!session) return null;
  const orders = db.prepare('SELECT * FROM orders WHERE session_id=? ORDER BY id').all(sessionId).map(o => ({...o, items: db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(o.id)}));
  const items = orders.flatMap(o => o.items);
  const subtotal = items.reduce((sum,i)=>sum + i.unit_price*i.quantity,0);
  const tax = Math.round(subtotal * TAX_RATE) / 100;
  const bill = db.prepare('SELECT * FROM bills WHERE session_id=?').get(sessionId) || null;
  return {...session, orders, items, subtotal: money(subtotal), tax_rate:TAX_RATE, tax:money(tax), total:money(subtotal+tax), bill};
}
function money(v) { return Math.round((Number(v)+Number.EPSILON)*100)/100; }
function getLanIps() { const nets=os.networkInterfaces(), ips=[]; for (const entries of Object.values(nets)) for (const net of entries||[]) if (net.family==='IPv4' && !net.internal) ips.push(net.address); return ips; }
function getLanOrigin() { return `http://${getLanIps()[0]||'localhost'}:${PORT}`; }
function getAppOrigin() { return "https://attempts-posting-dietary-kings.trycloudflare.com"||getLanOrigin(); }

app.get('/api/health', (_req,res)=>res.json({ ok:true, uptime:Math.round(process.uptime()), realtime:io.engine.clientsCount, database:'connected', restaurant:RESTAURANT }));
app.get('/api/config', (_req,res)=>res.json({ restaurant:RESTAURANT, currency:process.env.CURRENCY||'INR', taxRate:TAX_RATE, googleReviewUrl:process.env.GOOGLE_REVIEW_URL||'', whatsappConfigured:!!(process.env.WHATSAPP_ACCESS_TOKEN&&process.env.WHATSAPP_PHONE_NUMBER_ID), origin:getAppOrigin(),publicUrlConfigured:!!PUBLIC_URL,lanOrigin:getLanOrigin(),lanIps:getLanIps(),localOrigin:`http://localhost:${PORT}` }));
app.get('/api/menu', (_req,res)=>res.json(db.prepare('SELECT * FROM menu_items WHERE available=1 ORDER BY category,name').all()));

app.get('/api/tables', allow('owner','waiter'), (_req,res)=>{
  const tables=db.prepare("SELECT * FROM tables WHERE active=1 AND name<>'Pickup Orders' ORDER BY id").all().map(t=>{
    const s=activeSession(t.id); const summary=s?sessionSummary(s.id):null;
    return {...t, sessionId:s?.id||null, occupied:!!s, orderCount:summary?.orders.length||0, estimatedTotal:summary?.total||0, billStatus:summary?.bill?.status||'none', isPickup:false};
  });
  // Include pickup active sessions as well
  const pickupSessions = db.prepare("SELECT s.id sessionId, s.table_id FROM sessions s JOIN tables t ON t.id=s.table_id WHERE t.name='Pickup Orders' AND s.status='open' ORDER BY s.id DESC").all();
  const pickupEstimated = pickupSessions.reduce((acc, ps) => acc + (sessionSummary(ps.sessionId)?.total || 0), 0);
  tables.push({ id: pickupTableId, name: 'Pickup Orders', capacity: 1, active: 1, sessionId: pickupSessions[0]?.sessionId || null, occupied: pickupSessions.length > 0, orderCount: pickupSessions.length, estimatedTotal: pickupEstimated, billStatus: 'none', isPickup: true });
  res.json(tables);
});

app.post('/api/tables', allow('owner'), (req,res)=>{
  const name=String(req.body.name||'').trim(); const capacity=Math.min(20,Math.max(1,Number(req.body.capacity||4)));
  if(!name) return res.status(400).json({error:'Table name is required.'});
  try { const result=db.prepare('INSERT INTO tables(name,capacity) VALUES(?,?)').run(name,capacity); audit('table_created'); broadcast('tables:updated'); res.status(201).json(db.prepare('SELECT * FROM tables WHERE id=?').get(result.lastInsertRowid)); }
  catch { res.status(409).json({error:'That table name already exists.'}); }
});
app.patch('/api/tables/:id', allow('owner'), (req,res)=>{
  const t=db.prepare('SELECT * FROM tables WHERE id=?').get(Number(req.params.id)); if(!t) return res.status(404).json({error:'Table not found.'});
  if(req.body.active===false && activeSession(t.id)) return res.status(409).json({error:'Close the active table session before archiving this table.'});
  if(typeof req.body.name==='string') db.prepare('UPDATE tables SET name=?,capacity=? WHERE id=?').run(req.body.name.trim()||t.name,Math.max(1,Number(req.body.capacity||t.capacity)),t.id);
  if(typeof req.body.active==='boolean') db.prepare('UPDATE tables SET active=? WHERE id=?').run(req.body.active?1:0,t.id);
  broadcast('tables:updated'); res.json({ok:true});
});
app.get('/api/menu/manage', allow('owner'), (_req,res)=>res.json(db.prepare('SELECT * FROM menu_items ORDER BY category,name').all()));
app.post('/api/menu', allow('owner'), (req,res)=>{
  const {name,category,description='',price,image='',available=true}=req.body;
  if(!String(name||'').trim()||!String(category||'').trim()||!Number.isFinite(Number(price))||Number(price)<0) return res.status(400).json({error:'Name, category and a valid non-negative price are required.'});
  const result=db.prepare('INSERT INTO menu_items(name,category,description,price,image,available) VALUES(?,?,?,?,?,?)').run(String(name).trim(),String(category).trim(),String(description),Number(price),String(image),available?1:0);
  audit('menu_item_created'); broadcast('menu:updated'); res.status(201).json(db.prepare('SELECT * FROM menu_items WHERE id=?').get(result.lastInsertRowid));
});
app.patch('/api/menu/:id', allow('owner'), (req,res)=>{
  const old=db.prepare('SELECT * FROM menu_items WHERE id=?').get(Number(req.params.id)); if(!old) return res.status(404).json({error:'Menu item not found.'});
  const v={name:req.body.name??old.name,category:req.body.category??old.category,description:req.body.description??old.description,price:req.body.price??old.price,image:req.body.image??old.image,available:req.body.available===undefined?old.available:(req.body.available?1:0)};
  if(!String(v.name).trim()||!Number.isFinite(Number(v.price))||Number(v.price)<0) return res.status(400).json({error:'Invalid menu item details.'});
  db.prepare('UPDATE menu_items SET name=?,category=?,description=?,price=?,image=?,available=? WHERE id=?').run(v.name,v.category,v.description,Number(v.price),v.image,v.available,old.id); broadcast('menu:updated'); res.json({ok:true});
});
app.get('/api/orders', allow('owner','waiter','kitchen'), (req,res)=>{
  const status=req.query.status;
  let orders=db.prepare(`SELECT o.*,t.name table_name FROM orders o JOIN tables t ON t.id=o.table_id ORDER BY o.id DESC LIMIT 200`).all();
  if(status) orders=orders.filter(o=>o.status===status);
  res.json(orders.map(o=>({...o,items:db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(o.id)})));
});
app.get('/api/table-session/:tableId', (req,res)=>{
  const table=db.prepare('SELECT * FROM tables WHERE id=? AND active=1').get(Number(req.params.tableId)); if(!table) return res.status(404).json({error:'Table not found.'});
  const session=activeSession(table.id); res.json({table,session:session?sessionSummary(session.id):null,menu:db.prepare('SELECT * FROM menu_items WHERE available=1 ORDER BY category,name').all()});
});
app.post('/api/orders', (req,res)=>{
  const r=role(req); if(!['customer','waiter','owner'].includes(r)) return res.status(403).json({error:'This role cannot create orders.'});
  const tableId=Number(req.body.tableId), items=Array.isArray(req.body.items)?req.body.items:[];
  const table=db.prepare('SELECT * FROM tables WHERE id=? AND active=1').get(tableId); if(!table) return res.status(404).json({error:'Choose a valid table.'});
  if(!items.length) return res.status(400).json({error:'Add at least one item to the order.'});
  const prepared=[];
  for(const item of items){const menu=db.prepare('SELECT * FROM menu_items WHERE id=? AND available=1').get(Number(item.menuItemId)); const qty=Math.floor(Number(item.quantity)); if(!menu||!Number.isInteger(qty)||qty<1||qty>50) return res.status(400).json({error:'One or more items are unavailable or have an invalid quantity.'}); prepared.push({menu,qty,notes:String(item.notes||'').slice(0,300)});}
  const tx=db.transaction(()=>{
    let session=activeSession(tableId); if(!session){const s=db.prepare("INSERT INTO sessions(table_id,status) VALUES(?,'open')").run(tableId); session=db.prepare('SELECT * FROM sessions WHERE id=?').get(s.lastInsertRowid);}
    const o=db.prepare('INSERT INTO orders(session_id,table_id,source,status,customer_note) VALUES(?,?,? ,\'new\',?)').run(session.id,tableId,r,String(req.body.note||'').slice(0,300));
    const add=db.prepare('INSERT INTO order_items(order_id,menu_item_id,item_name,unit_price,quantity,notes,status) VALUES(?,?,?,?,?,?,\'new\')');
    prepared.forEach(p=>add.run(o.lastInsertRowid,p.menu.id,p.menu.name,p.menu.price,p.qty,p.notes));
    return Number(o.lastInsertRowid);
  });
  const orderId=tx(); audit(r==='customer'?'customer_order_created':'staff_order_created'); const order=db.prepare('SELECT o.*,t.name table_name FROM orders o JOIN tables t ON t.id=o.table_id WHERE o.id=?').get(orderId); order.items=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId); broadcast('orders:updated',{orderId,tableId}); broadcast('tables:updated'); res.status(201).json(order);
});
app.patch('/api/orders/:id/status', allow('owner','waiter','kitchen'), (req,res)=>{
  const status=String(req.body.status||''); const allowed=['new','preparing','ready','served','cancelled']; if(!allowed.includes(status)) return res.status(400).json({error:'Unsupported order status.'});
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(Number(req.params.id)); if(!order) return res.status(404).json({error:'Order not found.'});
  const actor=role(req);
  if(actor==='kitchen'&&!['preparing','ready','cancelled'].includes(status)) return res.status(403).json({error:'Kitchen can only update preparation status. A waiter must mark ready food as served.'});
  if(actor==='waiter'&&status==='served'&&order.status!=='ready') return res.status(409).json({error:'Only orders marked Ready by the kitchen can be marked Served.'});
  if(actor==='waiter'&&!['served','cancelled'].includes(status)) return res.status(403).json({error:'Waiters can mark a ready order as served or cancel an order. Kitchen controls preparation status.'});
  db.prepare('UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status,order.id);
  db.prepare('UPDATE order_items SET status=? WHERE order_id=?').run(status,order.id); broadcast('orders:updated',{orderId:order.id,tableId:order.table_id}); res.json({ok:true});
});
app.get('/api/bill/:tableId', allow('owner'), (req,res)=>{
  const s=activeSession(Number(req.params.tableId)); if(!s) return res.status(404).json({error:'No active session for this table.'});
  const summary=sessionSummary(s.id); if(!summary.orders.length) return res.status(404).json({error:'There are no orders for this table yet.'});
  const bill=summary.bill || createBill(s.id,summary); res.json({...sessionSummary(s.id),bill});
});
function createBill(sessionId, summary) {
  const invoice=`RT-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${String(sessionId).padStart(4,'0')}`;
  db.prepare('INSERT OR IGNORE INTO bills(session_id,invoice_no,subtotal,tax_rate,tax_amount,total,paid_amount,status) VALUES(?,?,?,?,?,?,0,\'pending\')').run(sessionId,invoice,summary.subtotal,summary.tax_rate,summary.tax,summary.total);
  return db.prepare('SELECT * FROM bills WHERE session_id=?').get(sessionId);
}
app.post('/api/payments', allow('owner'), (req,res)=>{
  const tableId=Number(req.body.tableId), sessionId=Number(req.body.sessionId), amount=money(Number(req.body.amount)), method=String(req.body.method||'');
  if(!['Cash','UPI','Card','Other'].includes(method)||!Number.isFinite(amount)||amount<=0) return res.status(400).json({error:'Enter a valid payment amount and method.'});
  const incomingPhone=normalizePhone(req.body.customerPhone||''); if(incomingPhone&&!validPhone(incomingPhone))return res.status(400).json({error:'Enter a valid customer phone number with country code.'});
  const s=sessionId?db.prepare("SELECT * FROM sessions WHERE id=? AND status='open'").get(sessionId):activeSession(tableId); if(!s) return res.status(404).json({error:'No active table session.'}); const summary=sessionSummary(s.id); if(!summary.orders.length) return res.status(400).json({error:'No orders to bill.'});
  const bill=summary.bill||createBill(s.id,summary); const balance=money(bill.total-bill.paid_amount); if(amount>balance+0.009) return res.status(400).json({error:`Payment exceeds the remaining balance of ₹${balance.toFixed(2)}.`});
  const tx=db.transaction(()=>{db.prepare('INSERT INTO payments(bill_id,method,amount,reference) VALUES(?,?,?,?)').run(bill.id,method,amount,String(req.body.reference||'').slice(0,100));const paid=money(bill.paid_amount+amount);const status=paid>=bill.total-0.009?'paid':'partial';db.prepare('UPDATE bills SET paid_amount=?,status=? WHERE id=?').run(paid,status,bill.id);if(status==='paid')db.prepare("UPDATE sessions SET status='closed',closed_at=CURRENT_TIMESTAMP WHERE id=?").run(s.id);return {paid,status};});
  const result=tx(); const customerName=String(req.body.customerName||'').trim().slice(0,100), customerPhone=normalizePhone(req.body.customerPhone||''); if(customerName||customerPhone){if(customerPhone&&!validPhone(customerPhone))return res.status(400).json({error:'Enter a valid customer phone number with country code.'});db.prepare('UPDATE bills SET customer_name=?,customer_phone=? WHERE id=?').run(customerName,customerPhone,bill.id);db.prepare('UPDATE payments SET customer_name=?,customer_phone=? WHERE bill_id=?').run(customerName,customerPhone,bill.id);if(customerPhone){db.prepare('INSERT INTO customer_contacts(phone,whatsapp_opt_in) VALUES(?,?) ON CONFLICT(phone) DO UPDATE SET whatsapp_opt_in=MAX(customer_contacts.whatsapp_opt_in,excluded.whatsapp_opt_in),updated_at=CURRENT_TIMESTAMP').run(customerPhone,req.body.whatsappOptIn===true?1:0);}} audit('payment_recorded'); broadcast('billing:updated',{tableId:s.table_id,billId:bill.id,sessionId:s.id,status:result.status}); broadcast('tables:updated'); res.status(201).json({ok:true,...result,sessionId:s.id,tableId,bill:db.prepare('SELECT * FROM bills WHERE id=?').get(bill.id),payments:db.prepare('SELECT * FROM payments WHERE bill_id=? ORDER BY id').all(bill.id)});
});
// Public customer-facing payment state only returns a minimal receipt status for the customer's own order id.
app.get('/api/customer-order/:orderId', (req,res)=>{
  const order=db.prepare('SELECT id,session_id,table_id FROM orders WHERE id=?').get(Number(req.params.orderId));
  if(!order) return res.status(404).json({error:'Order not found.'});
  const bill=db.prepare('SELECT invoice_no,total,paid_amount,status,created_at FROM bills WHERE session_id=?').get(order.session_id);
  res.json({orderId:order.id,sessionId:order.session_id,tableId:order.table_id,paid:bill?.status==='paid',bill:bill||null});
});
function normalizePhone(value){
  let clean = String(value || '').replace(/[\s()-]/g, '').replace(/^00/, '+');
  if (/^[6-9]\d{9}$/.test(clean)) {
    clean = '+91' + clean;
  }
  return clean;
}
function validPhone(phone){return /^\+?[1-9]\d{9,14}$/.test(phone);}
async function sendWhatsAppText(phone, text, templateName=process.env.WHATSAPP_EBILL_TEMPLATE||''){
  const token=process.env.WHATSAPP_ACCESS_TOKEN, phoneId=process.env.WHATSAPP_PHONE_NUMBER_ID;
  if(!token||!phoneId) return {sent:false,configured:false};
  const version=process.env.WHATSAPP_API_VERSION||'v23.0';
  const payload=templateName?{messaging_product:'whatsapp',recipient_type:'individual',to:phone.replace(/^\+/,''),type:'template',template:{name:templateName,language:{code:process.env.WHATSAPP_TEMPLATE_LANGUAGE||'en'},components:[{type:'body',parameters:[{type:'text',text:String(text).slice(0,1024)}]}]}}:{messaging_product:'whatsapp',recipient_type:'individual',to:phone.replace(/^\+/,''),type:'text',text:{preview_url:false,body:text}};
  const response=await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error?.message||'WhatsApp delivery failed.');
  return {sent:true,configured:true,messageId:data.messages?.[0]?.id||''};
}

// API Endpoint to generate a dynamic payment QR code for a specific bill or amount
app.get('/api/billing/qr/:billId', allow('owner'), async (req, res) => {
  try {
    const billId = Number(req.params.billId);
    const bill = db.prepare('SELECT * FROM bills WHERE id=?').get(billId);
    
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found.' });
    }

    const upiId = process.env.UPI_ID;
    const payeeName = process.env.PAYEE_NAME || RESTAURANT;
    const currency = process.env.CURRENCY || 'INR';

    if (!upiId) {
      return res.status(500).json({ error: 'UPI_ID is not configured in environment variables.' });
    }

    // Calculate remaining balance to pay
    const balanceAmount = Math.max(0, bill.total - bill.paid_amount);
    if (balanceAmount <= 0) {
      return res.status(400).json({ error: 'This bill is already fully paid.' });
    }

    // 1. Construct standard UPI payment string with fixed amount & invoice note
    const encodedName = encodeURIComponent(payeeName);
    const paymentString = `upi://pay?pa=${upiId}&pn=${encodedName}&am=${balanceAmount.toFixed(2)}&cu=${currency}&tn=Invoice_${bill.invoice_no}`;

    // 2. Generate base QR buffer using 'qrcode' package (High error correction for logo overlay)
    const qrBuffer = await QRCode.toBuffer(paymentString, {
      type: 'png',
      errorCorrectionLevel: 'H',
      width: 400,
      margin: 2
    });

    const logoPath = path.join(__dirname, 'public', 'log.png');
    let finalImageBuffer = qrBuffer;

    // 3. Embed logo in the center if it exists
    if (fs.existsSync(logoPath)) {
      try {
        const resizedLogo = await sharp(logoPath)
          .resize(80, 80, { fit: 'contain' })
          .toBuffer();

        finalImageBuffer = await sharp(qrBuffer)
          .composite([{ input: resizedLogo, gravity: 'center' }])
          .png()
          .toBuffer();
      } catch (logoError) {
        console.warn('Could not embed logo into bill QR:', logoError.message);
      }
    }

    // 4. Send back image stream directly to frontend POS billing modal/screen
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="bill-${bill.invoice_no}-qr.png"`);
    res.send(finalImageBuffer);

  } catch (error) {
    console.error('[Billing QR Error]', error);
    res.status(500).json({ error: 'Could not generate payment QR code.' });
  }
});

app.post('/api/customer/e-bill', async (req,res)=>{
  try {
    const sessionId=Number(req.body.sessionId), phone=normalizePhone(req.body.phone), consent=req.body.whatsappOptIn===true;
    if(!validPhone(phone)) return res.status(400).json({error:'Enter a valid phone number with country code, e.g. +919876543210.'});
    if(!consent) return res.status(400).json({error:'WhatsApp consent is required to save this number for restaurant updates.'});
    const session=db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    if(!session) return res.status(404).json({error:'Bill session not found.'});
    const bill=db.prepare("SELECT * FROM bills WHERE session_id=? AND status='paid'").get(sessionId);
    if(!bill) return res.status(409).json({error:'The bill is not marked paid yet.'});
    const tx=db.transaction(()=>{
      db.prepare("INSERT INTO customer_contacts(phone,whatsapp_opt_in) VALUES(?,1) ON CONFLICT(phone) DO UPDATE SET whatsapp_opt_in=1,updated_at=CURRENT_TIMESTAMP").run(phone);
      const contact=db.prepare('SELECT * FROM customer_contacts WHERE phone=?').get(phone);
      db.prepare('INSERT INTO ebill_requests(session_id,contact_id) VALUES(?,?)').run(sessionId,contact.id);
      return contact;
    });
    const contact=tx();
    const lines=db.prepare('SELECT item_name,quantity,unit_price FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE session_id=?) ORDER BY id').all(sessionId);
    const table=db.prepare('SELECT name FROM tables WHERE id=?').get(session.table_id);
    const items=lines.map(i=>`${i.quantity} x ${i.item_name} — ₹${money(i.quantity*i.unit_price).toFixed(2)}`).join('\n');
    const message=`${RESTAURANT} — E-bill\nInvoice: ${bill.invoice_no}\nTable: ${table?.name||session.table_id}\n\n${items}\n\nSubtotal: ₹${bill.subtotal.toFixed(2)}\nTax: ₹${bill.tax_amount.toFixed(2)}\nTotal paid: ₹${bill.total.toFixed(2)}\nPayment status: PAID\nThank you for dining with us!`;
    try {
      const delivery=await sendWhatsAppText(phone,message);
      if(delivery.sent) return res.json({ok:true,sent:true,message:'E-bill sent to WhatsApp.',phoneMasked:phone.replace(/^(.{3}).+(.{3})$/,'$1••••••$2')});
    } catch(error) { console.error('[WhatsApp e-bill]',error.message); }
    const waPhone=phone.replace(/\D/g,'');
    res.json({ok:true,sent:false,whatsappUrl:`https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`,message:'Your number is saved with WhatsApp consent. Automatic delivery is not configured, so open WhatsApp to send the prepared e-bill.' ,phoneMasked:phone.replace(/^(.{3}).+(.{3})$/,'$1••••••$2')});
  } catch(error){console.error(error);res.status(500).json({error:'Could not prepare the e-bill.'});}
});
app.get('/api/broadcasts', allow('super-admin'), (_req,res)=>{
  const rows=db.prepare(`SELECT b.id,b.title,b.message,b.status,b.created_at,b.updated_at,b.sent_at,COUNT(d.id) delivery_count,SUM(CASE WHEN d.status='sent' THEN 1 ELSE 0 END) sent_count,SUM(CASE WHEN d.status='failed' THEN 1 ELSE 0 END) failed_count FROM broadcasts b LEFT JOIN broadcast_deliveries d ON d.broadcast_id=b.id GROUP BY b.id ORDER BY b.id DESC LIMIT 50`).all();
  res.json({broadcasts:rows.map(x=>({...x,delivery_count:x.delivery_count||0,sent_count:x.sent_count||0,failed_count:x.failed_count||0})),eligibleAudience:db.prepare('SELECT COUNT(*) n FROM customer_contacts WHERE whatsapp_opt_in=1').get().n,whatsappConfigured:!!(process.env.WHATSAPP_ACCESS_TOKEN&&process.env.WHATSAPP_PHONE_NUMBER_ID)});
});
app.post('/api/broadcasts', allow('super-admin'), (req,res)=>{
  const title=String(req.body.title||'').trim().slice(0,100), message=String(req.body.message||'').trim().slice(0,3000), action=req.body.action==='send'?'send':'draft';
  if(!title||!message) return res.status(400).json({error:'Campaign title and message are required.'});
  const result=db.prepare('INSERT INTO broadcasts(title,message,status) VALUES(?,?,?)').run(title,message,'draft');
  audit('broadcast_draft_created');
  if(action==='send') return res.status(201).json({ok:true,broadcast:db.prepare('SELECT id,title,message,status,created_at FROM broadcasts WHERE id=?').get(result.lastInsertRowid),notice:'Campaign saved as a draft. Review it and use Send when WhatsApp delivery is configured.'});
  res.status(201).json({ok:true,broadcast:db.prepare('SELECT id,title,message,status,created_at FROM broadcasts WHERE id=?').get(result.lastInsertRowid)});
});
app.patch('/api/broadcasts/:id', allow('super-admin'), (req,res)=>{
  const row=db.prepare('SELECT * FROM broadcasts WHERE id=?').get(Number(req.params.id));
  if(!row) return res.status(404).json({error:'Campaign not found.'});
  if(row.status==='sent') return res.status(409).json({error:'Sent campaigns cannot be edited.'});
  const title=String(req.body.title??row.title).trim().slice(0,100), message=String(req.body.message??row.message).trim().slice(0,3000);
  if(!title||!message) return res.status(400).json({error:'Campaign title and message are required.'});
  db.prepare("UPDATE broadcasts SET title=?,message=?,status='draft',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(title,message,row.id);
  res.json({ok:true});
});
app.post('/api/broadcasts/:id/send', allow('super-admin'), async (req,res)=>{
  const campaign=db.prepare("SELECT * FROM broadcasts WHERE id=?").get(Number(req.params.id));
  if(!campaign) return res.status(404).json({error:'Campaign not found.'});
  if(campaign.status==='sent') return res.status(409).json({error:'This campaign has already been sent.'});
  if(!process.env.WHATSAPP_ACCESS_TOKEN||!process.env.WHATSAPP_PHONE_NUMBER_ID) return res.status(503).json({error:'WhatsApp Cloud API is not configured. Add WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID to .env before sending. The campaign remains a draft.'});
  const contacts=db.prepare("SELECT c.id,c.phone FROM customer_contacts c WHERE c.whatsapp_opt_in=1 AND c.id NOT IN (SELECT contact_id FROM broadcast_deliveries WHERE broadcast_id=? AND status='sent')").all(campaign.id);
  if(!contacts.length) return res.status(400).json({error:'There are no customers who opted in to WhatsApp broadcasts.'});
  const insert=db.prepare('INSERT INTO broadcast_deliveries(broadcast_id,contact_id,status,provider_message_id,error,sent_at) VALUES(?,?,?,?,?,?)');
  let sent=0, failed=0;
  for(const c of contacts){
    try { const out=await sendWhatsAppText(c.phone,campaign.message,process.env.WHATSAPP_BROADCAST_TEMPLATE||''); if(!out.sent) throw new Error('WhatsApp Cloud API is not configured.'); insert.run(campaign.id,c.id,'sent',out.messageId,'',new Date().toISOString()); sent++; }
    catch(error){insert.run(campaign.id,c.id,'failed','',String(error.message||'Delivery failed').slice(0,500),null);failed++;}
  }
  if(failed===0) db.prepare("UPDATE broadcasts SET status='sent',sent_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(campaign.id); else db.prepare("UPDATE broadcasts SET status='draft',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(campaign.id);
  audit('broadcast_send_attempted');
  res.json({ok:failed===0,sent,failed,total:contacts.length,status:sent>0?'sent':'draft',message:`WhatsApp delivery complete: ${sent} sent, ${failed} failed.`});
});

app.get('/api/pickup/qr.png', (req,res)=>{
  const target=`${getAppOrigin()}/customer/pickup.html`;
  res.type('png');
  QRCode.toFileStream(res,target,{width:700,margin:2,errorCorrectionLevel:'H'});
});
app.get('/api/pickup/qr', allow('owner'), (req,res)=>{
  res.json({url:`${getAppOrigin()}/customer/pickup.html`});
});

app.post('/api/pickup/orders', async (req,res)=>{
 const name=String(req.body.name||'').trim().slice(0,100), phone=normalizePhone(req.body.phone), items=Array.isArray(req.body.items)?req.body.items:[];
 if(name.length<2||!validPhone(phone))return res.status(400).json({error:'Enter customer name and a valid phone number with country code.'});
 if(!items.length)return res.status(400).json({error:'Add at least one menu item.'});
 const prepared=[];for(const item of items){const m=db.prepare('SELECT * FROM menu_items WHERE id=? AND available=1').get(Number(item.menuItemId));const qty=Math.floor(Number(item.quantity));if(!m||qty<1||qty>50)return res.status(400).json({error:'An item is unavailable or quantity is invalid.'});prepared.push({m,qty});}
 const tx=db.transaction(()=>{const ss=db.prepare("INSERT INTO sessions(table_id,status) VALUES(?,'open')").run(pickupTableId);const sid=Number(ss.lastInsertRowid);const oo=db.prepare("INSERT INTO orders(session_id,table_id,source,status,order_type,customer_name,customer_phone) VALUES(?,?, 'pickup_qr','new','pickup',?,?)").run(sid,pickupTableId,name,phone);const add=db.prepare("INSERT INTO order_items(order_id,menu_item_id,item_name,unit_price,quantity,status) VALUES(?,?,?,?,?,'new')");prepared.forEach(x=>add.run(oo.lastInsertRowid,x.m.id,x.m.name,x.m.price,x.qty));return {sessionId:sid,orderId:Number(oo.lastInsertRowid)};});
 const out=tx();createBill(out.sessionId,sessionSummary(out.sessionId));audit('pickup_order_created');broadcast('orders:updated',{orderId:out.orderId,tableId:pickupTableId,orderType:'pickup'});res.status(201).json(out);
});
app.get('/api/pickup/status/:orderId',(req,res)=>{const o=db.prepare("SELECT id,session_id,status,customer_name,order_type FROM orders WHERE id=? AND order_type='pickup'").get(Number(req.params.orderId));if(!o)return res.status(404).json({error:'Pickup order not found.'});const summary=sessionSummary(o.session_id);const bill=db.prepare('SELECT status,total,paid_amount,invoice_no FROM bills WHERE session_id=?').get(o.session_id)||null;res.json({order:o,session:summary,bill});});
app.get('/api/bill/session/:sessionId',allow('owner'),(req,res)=>{const session=db.prepare("SELECT * FROM sessions WHERE id=? AND status='open'").get(Number(req.params.sessionId));if(!session)return res.status(404).json({error:'Open order session not found.'});const summary=sessionSummary(session.id);if(!summary)return res.status(404).json({error:'Session not found.'});const bill=summary.bill||createBill(session.id,summary);res.json({...sessionSummary(session.id),bill});});

// Allow owner to append extra items (water bottle, soft drink, etc.) to an active bill session
app.post('/api/sessions/:sessionId/items', allow('owner'), (req,res)=>{
  const sessionId = Number(req.params.sessionId);
  const { menuItemId, quantity = 1, notes = '' } = req.body;
  const session = db.prepare("SELECT * FROM sessions WHERE id=? AND status='open'").get(sessionId);
  if (!session) return res.status(404).json({error:'Open session not found.'});
  const menu = db.prepare('SELECT * FROM menu_items WHERE id=?').get(Number(menuItemId));
  if (!menu) return res.status(404).json({error:'Menu item not found.'});
  
  const tx = db.transaction(() => {
    let order = db.prepare("SELECT * FROM orders WHERE session_id=? AND source='owner' AND status='new' ORDER BY id DESC LIMIT 1").get(sessionId);
    if (!order) {
      const resOrd = db.prepare("INSERT INTO orders(session_id,table_id,source,status,customer_note) VALUES(?,?, 'owner','new','Counter addition')").run(sessionId, session.table_id);
      order = { id: resOrd.lastInsertRowid };
    }
    db.prepare('INSERT INTO order_items(order_id,menu_item_id,item_name,unit_price,quantity,notes,status) VALUES(?,?,?,?,?,?,\'new\')')
      .run(order.id, menu.id, menu.name, menu.price, Math.max(1, Number(quantity)), String(notes));
    db.prepare('DELETE FROM bills WHERE session_id=? AND status=\'pending\'').run(sessionId);
  });
  tx();
  audit('owner_added_session_item');
  broadcast('tables:updated');
  res.json({ok:true, session: sessionSummary(sessionId)});
});

app.get('/api/owner/payments',allow('owner'),(_req,res)=>{const rows=db.prepare(`SELECT b.id bill_id,b.invoice_no,b.total,b.paid_amount,b.status,b.created_at,COALESCE(NULLIF(b.customer_name,''),(SELECT customer_name FROM orders WHERE session_id=s.id ORDER BY id LIMIT 1),'') customer_name,COALESCE(NULLIF(b.customer_phone,''),(SELECT customer_phone FROM orders WHERE session_id=s.id ORDER BY id LIMIT 1),'') customer_phone,b.ebill_sent_at,s.id session_id,t.name table_name,group_concat(DISTINCT p.method) methods FROM bills b JOIN sessions s ON s.id=b.session_id JOIN tables t ON t.id=s.table_id LEFT JOIN payments p ON p.bill_id=b.id GROUP BY b.id ORDER BY b.id DESC LIMIT 500`).all();res.json({payments:rows,autoSend:db.prepare("SELECT value FROM app_settings WHERE key='auto_send_ebill'").get()?.value==='on'});});
app.get('/api/owner/settings',allow('owner'),(_req,res)=>res.json({autoSend:db.prepare("SELECT value FROM app_settings WHERE key='auto_send_ebill'").get()?.value==='on',whatsappConfigured:!!(process.env.WHATSAPP_ACCESS_TOKEN&&process.env.WHATSAPP_PHONE_NUMBER_ID)}));
app.put('/api/owner/settings',allow('owner'),(req,res)=>{const value=req.body.autoSend===true?'on':'off';db.prepare("INSERT INTO app_settings(key,value) VALUES('auto_send_ebill',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);res.json({ok:true,autoSend:value==='on'});});
app.post('/api/owner/bills/:id/send-ebill',allow('owner'),async(req,res)=>{try{const bill=db.prepare('SELECT * FROM bills WHERE id=?').get(Number(req.params.id));if(!bill)return res.status(404).json({error:'Bill not found.'});if(bill.status!=='paid')return res.status(409).json({error:'Only fully paid bills can be sent.'});const phone=normalizePhone(req.body.phone||bill.customer_phone);if(!validPhone(phone))return res.status(400).json({error:'Enter the customer phone number first.'});const lines=db.prepare('SELECT item_name,quantity,unit_price FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE session_id=?) ORDER BY id').all(bill.session_id);const session=db.prepare('SELECT s.table_id,t.name FROM sessions s JOIN tables t ON t.id=s.table_id WHERE s.id=?').get(bill.session_id);const customerName=String(req.body.customerName||bill.customer_name||'Customer').slice(0,100);const message=`${RESTAURANT} — E-bill\nInvoice: ${bill.invoice_no}\nCustomer: ${customerName}\nOrder type: ${session.name==='Pickup Orders'?'Pickup':'Dine-in'}\n\n${lines.map(i=>`${i.quantity} x ${i.item_name} — ₹${money(i.quantity*i.unit_price).toFixed(2)}`).join('\n')}\n\nSubtotal: ₹${bill.subtotal.toFixed(2)}\nTax: ₹${bill.tax_amount.toFixed(2)}\nTotal: ₹${bill.total.toFixed(2)}\nPaid: ₹${bill.paid_amount.toFixed(2)}\nThank you!`;const out=await sendWhatsAppText(phone,message);if(!out.sent)return res.status(503).json({error:'WhatsApp Cloud API is not configured. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID.'});db.prepare('UPDATE bills SET customer_name=?,customer_phone=?,ebill_sent_at=CURRENT_TIMESTAMP WHERE id=?').run(customerName,phone,bill.id);db.prepare("INSERT INTO customer_contacts(phone,whatsapp_opt_in) VALUES(?,0) ON CONFLICT(phone) DO NOTHING").run(phone);audit('owner_ebill_sent');res.json({ok:true,message:'E-bill sent successfully.'});}catch(e){console.error('[Owner e-bill]',e.message);res.status(502).json({error:e.message||'WhatsApp delivery failed.'});}});

app.get('/api/reports', allow('owner'), (_req,res)=>{
  const bills=db.prepare('SELECT * FROM bills ORDER BY id DESC LIMIT 500').all(); const orders=db.prepare('SELECT * FROM orders').all(); const payments=db.prepare('SELECT * FROM payments').all();
  res.json({bills,ordersCount:orders.length,orderCount:orders.length,paid:money(payments.reduce((s,p)=>s+p.amount,0)),pending:money(bills.reduce((s,b)=>s+Math.max(0,b.total-b.paid_amount),0)),byMethod:db.prepare('SELECT method,SUM(amount) amount FROM payments GROUP BY method').all(),topItems:db.prepare('SELECT item_name,SUM(quantity) quantity FROM order_items GROUP BY item_name ORDER BY quantity DESC LIMIT 8').all()});
});
app.get('/api/technical-status', allow('super-admin'), (_req,res)=>res.json({uptimeSeconds:Math.round(process.uptime()),connectedBrowsers:io.engine.clientsCount,database:'connected',databaseSizeBytes:(()=>{try{return (fs.statSync(path.join(__dirname,'data','restaurant.sqlite')).size)}catch{return null}})(), recentTechnicalEvents:db.prepare('SELECT event_type,created_at FROM audit_events ORDER BY id DESC LIMIT 10').all().map(x=>({event:x.event_type,at:x.created_at})), note:'No restaurant sales, orders, bills, customer details, or payment values are returned.'}));
app.get('/api/qr/:tableId.png', async (req,res)=>{
  const t=db.prepare('SELECT * FROM tables WHERE id=? AND active=1').get(Number(req.params.tableId)); if(!t) return res.status(404).send('Table not found');
  const target=`${getAppOrigin()}/customer/menu.html?table=${t.id}`; res.setHeader('Content-Type','image/png'); res.setHeader('Content-Disposition',`inline; filename="${t.name.replace(/[^a-z0-9]/gi,'-')}-qr.png"`); QRCode.toFileStream(res,target,{width:600,margin:2,errorCorrectionLevel:'H'});
});
app.get('/api/customer-status/:tableId', (req,res)=>{const s=activeSession(Number(req.params.tableId));res.json({session:s?sessionSummary(s.id):null});});
app.get('/api/owner/summary', allow('owner'), (_req,res)=>{
 const tables=db.prepare('SELECT COUNT(*) n FROM tables WHERE active=1').get().n, open=db.prepare("SELECT COUNT(*) n FROM sessions WHERE status='open'").get().n, orders=db.prepare("SELECT COUNT(*) n FROM orders WHERE date(created_at)=date('now','localtime')").get().n, paid=db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE date(created_at)=date('now','localtime')").get().n, pending=db.prepare("SELECT COUNT(*) n FROM bills WHERE status!='paid'").get().n;
 res.json({tables,openSessions:open,todayOrders:orders,todayCollections:money(paid),pendingBills:pending});
});
app.get('/api/qr/:tableId', allow('owner'), (req,res)=>{const t=db.prepare('SELECT * FROM tables WHERE id=?').get(Number(req.params.tableId));if(!t)return res.status(404).json({error:'Table not found'});res.json({table:t,origin:getAppOrigin(),url:`${getAppOrigin()}/customer/menu.html?table=${t.id}`});});

io.on('connection', socket=>{socket.emit('system:connected',{ok:true});socket.on('join:table', id=>{if(Number.isInteger(Number(id)))socket.join(`table:${Number(id)}`);});});
app.get('/', (_req,res)=>res.redirect('/owner/index.html'));
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Unexpected server error.'});});
server.listen(PORT,HOST,()=>{console.log(`\n${RESTAURANT} · RestaurantOS server`);console.log(`Local: http://localhost:${PORT}`);for(const ip of getLanIps())console.log(`LAN:   http://${ip}:${PORT}`);if(PUBLIC_URL){console.log(`Public: ${PUBLIC_URL}`);console.log('QR codes: using PUBLIC_URL; ensure it routes to this server and supports Socket.IO WebSockets.');console.warn('Security: change the initial staff credentials and use trusted HTTPS before public exposure.')}else{console.warn('PUBLIC_URL is not set. Customer QR codes use the LAN address and will not work over mobile internet.');console.log(`QR codes: ${getLanOrigin()}`)}console.log('SQLite: data/restaurant.sqlite');console.log('Press Ctrl+C to stop.\n');});