'use strict';
const config = require('./config');
const auth = require('./lib/auth');
const { createApp, startJobs } = require('./app');

// Eerste eigenaarsaccount via omgevingsvariabelen (alleen als er nog geen account is)
if (!auth.hasAdmin() && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  auth.createAdmin(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
  console.log(`Eigenaarsaccount aangemaakt voor ${process.env.ADMIN_EMAIL}. Verwijder ADMIN_PASSWORD nu uit je omgeving.`);
}

const app = createApp();
app.listen(config.port, config.host, () => {
  console.log(`Boekingsportaal draait op ${config.publicUrl} (poort ${config.port})`);
  if (!auth.hasAdmin()) console.log('Nog geen eigenaarsaccount. Maak er een aan met: npm run create-admin');
});
startJobs();
