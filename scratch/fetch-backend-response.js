const path = require('path');
const fs = require('fs');

// Load environment variables from .env.local
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx);
    const value = trimmed.substring(eqIdx + 1);
    if (!process.env[key]) process.env[key] = value;
  }
}

// Keep a reference to the original require
const originalRequire = module.constructor.prototype.require;

// Add mock opt paths to require context BEFORE requiring lambda/states/index.js
module.constructor.prototype.require = function (modulePath) {
  if (modulePath === '/opt/nodejs/authorizerContext') {
    return {
      getAuthorizerContext: () => ({
        organization_id: '00000000-0000-0000-0000-000000000001',
        user_id: '08617390-b001-708d-f61e-07a1698282ec'
      }),
      buildOrganizationFilter: (ctx, tableAlias) => ({
        condition: `${tableAlias}.organization_id = '00000000-0000-0000-0000-000000000001'::uuid`,
        params: []
      })
    };
  }
  if (modulePath === '/opt/nodejs/response') {
    return {
      successResponse: (body, headers) => ({ statusCode: 200, headers, body: JSON.stringify(body) }),
      errorResponse: (code, msg, headers) => ({ statusCode: code, headers, body: JSON.stringify({ error: msg }) })
    };
  }
  if (modulePath === '/opt/nodejs/db') {
    const { Pool } = require('pg');
    const pool = new Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: { rejectUnauthorized: false }
    });
    return {
      getDbClient: () => pool.connect()
    };
  }
  if (modulePath === '/opt/nodejs/sqlUtils') {
    return {
      formatSqlValue: (val) => `'${val}'`
    };
  }
  if (modulePath === '/opt/nodejs/embedding-composition') {
    return {
      composeStateEmbeddingSource: () => ''
    };
  }
  return originalRequire.apply(this, arguments);
};

const { handler } = require('../lambda/states/index.js');

async function main() {
  const stateId = '8042a781-d1f0-45a6-b547-a42dc24baa7a';
  console.log(`📡 Simulating GET /api/states/${stateId}...`);
  
  const event = {
    httpMethod: 'GET',
    pathParameters: {
      id: stateId
    }
  };

  const response = await handler(event);
  
  if (response.statusCode === 200) {
    const state = JSON.parse(response.body);
    console.log('\n✅ Response received successfully!');
    console.log(`State ID: ${state.id} | Author: ${state.captured_by_name || 'System'}`);
    console.log(`Text: "${state.observation_text || 'None'}"`);
    console.log(`Photos Array:`);
    state.photos.forEach((photo, pIdx) => {
      console.log(`  - Photo #${pIdx + 1}: ${photo.photo_description || 'No Label'}`);
      console.log(`    URL: ${photo.photo_url}`);
      console.log(`    Transcription: "${photo.transcription?.substring(0, 150)}..."`);
      console.log(`    Model ID: "${photo.model_id}"`);
      console.log(`    System Prompt: "${photo.system_prompt?.substring(0, 150)}..."`);
    });
  } else {
    console.error('❌ Error response:', response.body);
  }
  
  process.exit(0);
}

main().catch(console.error);
