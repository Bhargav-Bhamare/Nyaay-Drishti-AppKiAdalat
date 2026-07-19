require('dotenv').config({ path: '.env.vercel.local' });
const uri = process.env.MONGODB_URI;

if (!uri) {
  console.log('❌ MONGODB_URI is not set in Production');
  process.exit(1);
}

const match = uri.match(/^mongodb(\+srv)?:\/\/([^:]+):([^@]+)@(.+)$/);
if (!match) {
  console.log('❌ URI does not match expected mongodb(+srv)://user:pass@host pattern');
  console.log('Length:', uri.length, '| Starts with mongodb:', uri.startsWith('mongodb'));
  process.exit(1);
}

const [, srv, user, pass, rest] = match;
console.log('protocol:', srv ? 'mongodb+srv' : 'mongodb');
console.log('username length:', user.length);
console.log('password length:', pass.length);
console.log('host:', rest.split('/')[0]);
console.log('password needs URL-encoding:', encodeURIComponent(decodeURIComponent(pass)) !== pass);
