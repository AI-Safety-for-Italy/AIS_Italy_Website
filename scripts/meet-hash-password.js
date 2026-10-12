#!/usr/bin/env node
// Prints the value for ADMIN_PASSWORD_HASH, the hash of the admin panel
// password. The password itself is never stored anywhere.
//
//   node scripts/meet-hash-password.js            (asks for it)
//   node scripts/meet-hash-password.js 'secret'   (avoid: ends up in shell history)
const readline = require('readline');
const { hashPassword } = require('../server/auth');

async function ask() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Hide what is typed.
  rl._writeToOutput = (s) => {
    if (s.includes('Password')) rl.output.write(s);
  };
  const answer = await new Promise((resolve) => rl.question('Password: ', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

(async () => {
  const password = process.argv[2] || (await ask());
  if (password.length < 12) {
    console.error('Use at least 12 characters.');
    process.exit(1);
  }
  console.log(`\nADMIN_PASSWORD_HASH=${hashPassword(password)}`);
})();
