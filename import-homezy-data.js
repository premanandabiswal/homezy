const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'homezy-data.json'), 'utf8'));

async function importData() {
  const client = new MongoClient('mongodb://127.0.0.1:27017');
  await client.connect();

  const db = client.db('homezy');
  const users = db.collection('users');
  const bookings = db.collection('bookings');

  await users.deleteMany({});
  await bookings.deleteMany({});
  await users.createIndex({ email: 1 }, { unique: true });

  if (data.users && data.users.length) {
    await users.insertMany(data.users);
  }

  if (data.bookings && data.bookings.length) {
    await bookings.insertMany(data.bookings);
  }

  console.log('Inserted users:', await users.countDocuments());
  console.log('Inserted bookings:', await bookings.countDocuments());

  await client.close();
}

importData().catch((error) => {
  console.error('Mongo import failed:', error.message);
  process.exit(1);
});
