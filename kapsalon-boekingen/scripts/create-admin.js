'use strict';
// Gebruik: npm run create-admin -- eigenaar@salon.nl
// Het wachtwoord wordt interactief (verborgen) gevraagd, of via ADMIN_PASSWORD.
const readline = require('node:readline');
const auth = require('../src/lib/auth');
const { db } = require('../src/db');
const { hashPassword } = require('../src/lib/security');

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else rl.output.write('*'); };
    }
    rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  const email = process.argv[2] || await ask('E-mailadres eigenaar: ');
  const password = process.env.ADMIN_PASSWORD || await ask('Wachtwoord (min. 10 tekens): ', true);
  try {
    auth.validatePassword(password);
    const existing = db.prepare('SELECT id FROM admins WHERE email = ?').get(email.trim().toLowerCase());
    if (existing) {
      db.prepare('UPDATE admins SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?').run(hashPassword(password), existing.id);
      db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').run(existing.id);
      console.log(`Wachtwoord bijgewerkt voor ${email}.`);
    } else {
      auth.createAdmin(email, password);
      console.log(`Eigenaarsaccount aangemaakt voor ${email}.`);
    }
  } catch (err) {
    console.error(`Fout: ${err.message}`);
    process.exit(1);
  }
})();
