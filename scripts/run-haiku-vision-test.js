const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
require('dotenv').config({ path: './.env.local' });

// We use native fetch to get the image
async function runVisionTest(imageUrl) {
  const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' });
  const MODEL_ID = 'anthropic.claude-3-haiku-20240307-v1:0';

  console.log(`Fetching image from: ${imageUrl}`);
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.statusText}`);
  }
  
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const base64Data = buffer.toString('base64');
  
  // Determine media type
  let mediaType = 'image/jpeg';
  if (imageUrl.toLowerCase().endsWith('.png')) mediaType = 'image/png';
  if (imageUrl.toLowerCase().endsWith('.webp')) mediaType = 'image/webp';

  console.log(`Image downloaded. Size: ${Math.round(buffer.length / 1024)} KB. Media Type: ${mediaType}`);
  console.log(`Invoking ${MODEL_ID} for vision extraction...`);

  const payload = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1000,
    temperature: 0.1,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64Data
            }
          },
          {
            type: "text",
            text: "Describe what you see in this image. Extract any text that is visible. Do not classify the image or guess its broader context. Be strictly objective, grounded, and unbiased in your description."
          }
        ]
      }
    ]
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    body: JSON.stringify(payload),
    contentType: 'application/json',
    accept: 'application/json'
  });

  try {
    const t0 = Date.now();
    const result = await bedrockClient.send(command);
    const resultBody = JSON.parse(new TextDecoder().decode(result.body));
    const tEnd = Date.now();
    
    console.log(`\n=== HAIKU VISION OUTPUT (${tEnd - t0}ms) ===`);
    console.log(resultBody.content[0].text);
    console.log(`===========================================\n`);
    
  } catch (err) {
    console.error(`Bedrock invocation failed for ${imageUrl}:`);
    console.error(`Name: ${err.name}`);
    console.error(`Message: ${err.message}`);
  }
}

// Test with one of the compost photos (the one adding water)
const testUrl1 = "https://cwf-dev-assets.s3.us-west-2.amazonaws.com/organizations/00000000-0000-0000-0000-000000000001/images/PXL_20260329_051029213.jpg";
// Test with the screenshot showing 11% to test OCR
const testUrl2 = "https://cwf-dev-assets.s3.us-west-2.amazonaws.com/organizations/00000000-0000-0000-0000-000000000001/images/Screenshot_20260329-122557.png";

async function main() {
  console.log("--- TEST 1: Physical Scene (Water Container) ---");
  await runVisionTest(testUrl1);
  
  console.log("\n--- TEST 2: Digital Screenshot (OCR extraction) ---");
  await runVisionTest(testUrl2);
}

main();
