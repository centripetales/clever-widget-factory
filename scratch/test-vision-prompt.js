const { Pool } = require('pg');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
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

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

const bedrockClient = new BedrockRuntimeClient({ region: 'us-west-2' });

async function fetchImageBytes(photoUrl) {
  let url = photoUrl;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = `https://cwf-dev-assets.s3.us-west-2.amazonaws.com/${url}`;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch image from ${url}: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function getImageFormat(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'webp';
  return 'jpeg';
}

async function main() {
  const systemPrompt = `Provide a detailed description of the photo to serve as semantic context for downstream AI agents. Include:
1. Prominent physical objects and their counts (e.g. 1 paper document, 2 pages).
2. Object colors and key visual details.
3. Scene context (where the objects are situated, the background, or what is happening).
4. A clean transcription of any handwritten or printed text.
Note: The application operates in the Philippines. Transcribe the currency symbol as '₱' (Philippine Peso) and never substitute it with '$'.
Be objective, direct, and factual.`;

  const targetPhotos = [
    {
      label: 'Bir 2303 page 1',
      id: 'f7cf35ee-614a-4d18-98bc-fcd9f2316bbf',
      url: 'https://cwf-dev-assets.s3.us-west-2.amazonaws.com/organizations/00000000-0000-0000-0000-000000000001/images/1000032135.jpg'
    },
    {
      label: 'Bir 2303 page 2',
      id: 'd2161dc5-7d49-4d1b-a6bb-2e23122e6261',
      url: 'https://cwf-dev-assets.s3.us-west-2.amazonaws.com/organizations/00000000-0000-0000-0000-000000000001/images/1000032134.jpg'
    }
  ];

  for (let i = 0; i < targetPhotos.length; i++) {
    const photo = targetPhotos[i];
    console.log(`=========================================`);
    console.log(`TESTING BIR 2303 DOCUMENT - PAGE ${i + 1}`);
    console.log(`Label: ${photo.label}`);
    console.log(`Photo ID: ${photo.id}`);
    console.log(`S3 Url: ${photo.url}`);
    console.log(`-----------------------------------------`);

    try {
      const bytes = await fetchImageBytes(photo.url);
      const format = getImageFormat(bytes);
      console.log(`Downloading image: OK (${Math.round(bytes.length / 1024)} KB)`);

      const base64Data = bytes.toString('base64');
      const payload = {
        messages: [
          {
            role: "user",
            content: [
              {
                image: {
                  format: format,
                  source: { bytes: base64Data }
                }
              },
              { text: "Describe this image based on the system instructions." }
            ]
          }
        ],
        system: [{ text: systemPrompt }],
        inferenceConfig: {
          maxTokens: 1000,
          temperature: 0.1
        }
      };

      console.log(`Calling Bedrock us.amazon.nova-pro-v1:0...`);
      const t0 = Date.now();
      const bedrockRes = await bedrockClient.send(new InvokeModelCommand({
        modelId: 'us.amazon.nova-pro-v1:0',
        body: JSON.stringify(payload),
        contentType: 'application/json',
        accept: 'application/json'
      }));
      const responseBody = JSON.parse(new TextDecoder().decode(bedrockRes.body));
      const text = responseBody?.output?.message?.content?.[0]?.text;
      const duration = Date.now() - t0;

      console.log(`\n✓ Analysis complete in ${duration}ms:`);
      console.log(`--- PROMPT RESULT ---`);
      console.log(text.trim());
      console.log(`---------------------\n`);
    } catch (err) {
      console.error(`✗ Error testing photo:`, err.message);
    }
  }

  await pool.end();
}

main().catch(console.error);
