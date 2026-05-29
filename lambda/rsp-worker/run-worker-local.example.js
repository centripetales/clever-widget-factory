const fs = require('fs');
const envFile = fs.readFileSync('../../.env.local', 'utf-8');
envFile.split('\n').forEach(line => {
  const match = line.match(/^\s*([^#=]+)\s*=\s*(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
});
const { handler } = require('./index.js');
handler({}).then(() => console.log('Done')).catch(console.error);
