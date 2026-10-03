const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const { MongoClient } = require('mongodb');
const Razorpay = require('razorpay');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'homezy-data.json');
const FALLBACK_PORTS = [3000, 3001, 3002, 3003, 3004, 3005];
const HTML_FILE = path.join(ROOT, 'homezy_platform.html');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const MONGODB_DB = process.env.MONGODB_DB || 'homezy';
const RAZORPAY_KEY_ID = (process.env.RAZORPAY_KEY_ID || '').trim();
const RAZORPAY_KEY_SECRET = (process.env.RAZORPAY_KEY_SECRET || '').trim();
const hasRazorpayCredentials = RAZORPAY_KEY_ID.startsWith('rzp_')
  && RAZORPAY_KEY_SECRET.length > 0
  && !RAZORPAY_KEY_SECRET.startsWith('your_');
const razorpay = hasRazorpayCredentials
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null;

let mongoClient;
let database;

const seedData = {
  users: [
    { id: 'u1', name: 'Rahul Sharma', email: 'rahul@example.com', password: 'password123', role: 'customer', phone: '+91 9876543210', addresses: [{ id: 'a1', label: 'Home', address: '123 Main St, Kormangala, Bangalore' }] },
    { id: 'p1', name: 'Amit Kumar', email: 'amit@example.com', password: 'password123', role: 'provider', phone: '+91 8765432109', services: ['s1', 's2'], rating: 4.8, jobsCompleted: 145, earnings: 45000 },
    { id: 'a1', name: 'System Admin', email: 'admin@homezy.com', password: 'admin', role: 'admin', phone: '+91 0000000000' }
  ],
  bookings: [
    { id: 'HZ102948', customerId: 'u1', providerId: 'p1', serviceId: 's1', date: '2026-08-25', time: '10:00 AM', status: 'Completed', amount: 299, address: '123 Main St, Kormangala, Bangalore' },
    { id: 'HZ102949', customerId: 'u1', providerId: 'p1', serviceId: 's2', date: '2026-08-28', time: '02:00 PM', status: 'Confirmed', amount: 999, address: '123 Main St, Kormangala, Bangalore' }
  ]
};

function loadDataFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return seedData;

    const raw = fs.readFileSync(DATA_FILE, 'utf8').trim();
    if (!raw) return seedData;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.users) || !Array.isArray(parsed.bookings)) {
      throw new Error('Invalid data structure');
    }

    return parsed;
  } catch (error) {
    console.warn(`HOMEZY data file is invalid or unreadable. Falling back to seed data. ${error.message}`);
    return seedData;
  }
}

async function connectDatabase() {
  if (database) return database;

  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  database = mongoClient.db(MONGODB_DB);

  const users = database.collection('users');
  const bookings = database.collection('bookings');
  await users.createIndex({ email: 1 }, { unique: true });

  if (await users.countDocuments() === 0 && await bookings.countDocuments() === 0) {
    const source = loadDataFile();
    if (Array.isArray(source.users) && source.users.length) await users.insertMany(source.users);
    if (Array.isArray(source.bookings) && source.bookings.length) await bookings.insertMany(source.bookings);
    console.log('Imported initial HOMEZY data into MongoDB');
  }

  return database;
}

function publicUser(user) {
  const { password, ...safeUser } = user;
  return safeUser;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    request.on('error', reject);
  });
}

async function handleApi(request, response, url) {
  const db = await connectDatabase();
  const users = db.collection('users');
  const bookings = db.collection('bookings');

  if (request.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(response, 200, { ok: true, service: 'homezy-api', database: 'mongodb', onlinePayments: hasRazorpayCredentials });
  }

  if (request.method === 'POST' && url.pathname === '/api/payments/order') {
    if (!hasRazorpayCredentials || !razorpay) return sendJson(response, 503, { error: 'Online payments are not configured. Add matching Razorpay test key ID and secret.' });
    const body = await readJson(request);
    if (!Number.isInteger(body.amount) || body.amount < 1) return sendJson(response, 400, { error: 'A valid amount is required' });
    try {
      const order = await razorpay.orders.create({ amount: body.amount * 100, currency: 'INR', receipt: `homezy_${Date.now()}` });
      return sendJson(response, 200, { order, keyId: RAZORPAY_KEY_ID });
    } catch (error) {
      console.error('Razorpay order creation failed:', error.error?.description || error.message);
      return sendJson(response, 502, { error: 'Razorpay rejected the credentials. Use the key ID and secret from the same Razorpay test account.' });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/payments/verify') {
    if (!RAZORPAY_KEY_SECRET) return sendJson(response, 503, { error: 'Online payments are not configured' });
    const body = await readJson(request);
    if (!body.orderId || !body.paymentId || !body.signature) return sendJson(response, 400, { error: 'Payment verification details are required' });
    const expectedSignature = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(`${body.orderId}|${body.paymentId}`)
      .digest('hex');
    if (expectedSignature !== body.signature) return sendJson(response, 400, { error: 'Payment verification failed' });
    return sendJson(response, 200, { verified: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson(request);
    const user = await users.findOne({ email: body.email, password: body.password });
    if (!user) return sendJson(response, 401, { error: 'Invalid email or password' });
    return sendJson(response, 200, { user: publicUser(user) });
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readJson(request);
    if (!body.name || !body.email || !body.password) return sendJson(response, 400, { error: 'Name, email and password are required' });
    if (await users.findOne({ email: body.email })) return sendJson(response, 409, { error: 'An account with that email already exists' });
    const user = { id: `u${Date.now()}`, name: body.name, email: body.email, password: body.password, role: 'customer', addresses: [] };
    await users.insertOne(user);
    return sendJson(response, 201, { user: publicUser(user) });
  }

  if (request.method === 'PUT' && url.pathname.startsWith('/api/users/')) {
    const userId = decodeURIComponent(url.pathname.slice('/api/users/'.length));
    const user = await users.findOne({ id: userId });
    if (!user) return sendJson(response, 404, { error: 'User not found' });
    const body = await readJson(request);
    if (!body.name || !body.email) return sendJson(response, 400, { error: 'Name and email are required' });
    if (await users.findOne({ id: { $ne: userId }, email: body.email })) {
      return sendJson(response, 409, { error: 'That email is already in use' });
    }
    await users.updateOne({ id: userId }, { $set: {
      name: body.name,
      email: body.email,
      phone: body.phone || '',
      city: body.city || '',
      preferredTime: body.preferredTime || '',
      photo: body.photo || '',
      addresses: Array.isArray(body.addresses) ? body.addresses : []
    } });
    const updatedUser = await users.findOne({ id: userId });
    return sendJson(response, 200, { user: publicUser(updatedUser) });
  }

  if (request.method === 'GET' && url.pathname === '/api/bookings') {
    const customerId = url.searchParams.get('customerId');
    if (!customerId) return sendJson(response, 400, { error: 'customerId is required' });
    return sendJson(response, 200, { bookings: await bookings.find({ customerId }).toArray() });
  }

  if (request.method === 'POST' && url.pathname === '/api/bookings') {
    const body = await readJson(request);
    const required = ['customerId', 'serviceId', 'date', 'time', 'address', 'amount'];
    if (required.some(field => !body[field])) return sendJson(response, 400, { error: 'All booking fields are required' });
    const booking = { id: `HZ${crypto.randomInt(100000, 1000000)}`, customerId: body.customerId, serviceId: body.serviceId, providerId: 'p1', date: body.date, time: body.time, status: 'Pending', amount: body.amount, address: body.address, paymentMethod: body.paymentMethod || 'Cash on Service' };
    await bookings.insertOne(booking);
    return sendJson(response, 201, { booking });
  }

  sendJson(response, 404, { error: 'API route not found' });
}

function createServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
      if (request.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/homezy_platform.html')) {
        return sendJson(response, 404, { error: 'Not found' });
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(fs.readFileSync(HTML_FILE));
    } catch (error) {
      console.error(error);
      sendJson(response, 500, { error: 'Internal server error' });
    }
  });
}

function startServer(portIndex = 0) {
  const configuredPort = Number(process.env.PORT);
  const candidatePorts = configuredPort
    ? [configuredPort, ...FALLBACK_PORTS.filter(port => port !== configuredPort)]
    : FALLBACK_PORTS;
  const port = candidatePorts[portIndex] || 3000;
  const server = createServer();

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && portIndex < candidatePorts.length - 1) {
      console.warn(`Port ${port} is busy. Retrying on ${candidatePorts[portIndex + 1]}...`);
      startServer(portIndex + 1);
      return;
    }

    console.error(`Unable to start HOMEZY on port ${port}: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(port, HOST, () => {
    console.log(`HOMEZY running at http://${HOST}:${port}`);
  });
}

async function start() {
  await connectDatabase();
  startServer();
}

start().catch(error => {
  console.error('Unable to connect to MongoDB:', error.message);
  process.exitCode = 1;
});
