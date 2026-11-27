// Offline generátor hesel pro D1 seed — stejný algoritmus jako worker:
//   hash = sha256(`${salt}:${password}`) v hex.
// Použití: node scripts/hash-password.js <salt> <heslo>
// (či bez argů pro defaultní admin/reporter uživatele.)

const crypto = require('crypto');

function hashPassword(salt, password) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

const args = process.argv.slice(2);
if (args.length === 2) {
  console.log(`${args[0]}:${args[1]}`);
  console.log(hashPassword(args[0], args[1]));
} else {
  console.log('admin    salt=admin-salt-3f8a    heslo=admin123');
  console.log('  ->', hashPassword('admin-salt-3f8a', 'admin123'));
  console.log('reporter salt=reporter-salt-9c2d heslo=reporter123');
  console.log('  ->', hashPassword('reporter-salt-9c2d', 'reporter123'));
}
