const { handler } = require('./index.js');
const fs = require('fs');
const envFile = fs.readFileSync('../../.env.local', 'utf-8');
envFile.split('\n').forEach(line => {
  const match = line.match(/^\s*([^#=]+)\s*=\s*(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
});

async function run() {
  const event = {
    httpMethod: 'GET',
    queryStringParameters: { entity_type: 'action', entity_id: '7d58c576-7ee1-474c-984b-14411a6ba086' },
    requestContext: {
      authorizer: {
        lambda: {
          user_id: '00000000-0000-0000-0000-000000000000',
          organization_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
        }
      }
    }
  };
  const res = await handler(event);
  console.log(res.body);
}
run().catch(console.error);
