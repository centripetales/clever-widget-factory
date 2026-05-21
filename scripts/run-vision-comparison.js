const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
require('dotenv').config({ path: './.env.local' });

async function runVisionTest(modelId, imageUrl) {
  const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-west-2' });

  // Fetch the image and convert to Uint8Array
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const imageBytes = new Uint8Array(arrayBuffer);
  
  let format = 'jpeg'; // Default fallback
  if (imageBytes[0] === 0x89 && imageBytes[1] === 0x50) format = 'png';
  else if (imageBytes[0] === 0xFF && imageBytes[1] === 0xD8) format = 'jpeg';
  else if (imageBytes[0] === 0x52 && imageBytes[1] === 0x49) format = 'webp';

  const promptText = "Describe what you see in this image. Extract any text that is visible. Do not classify the image or guess its broader context. Be strictly objective, grounded, and unbiased in your description.";

  const command = new ConverseCommand({
    modelId: modelId,
    messages: [
      {
        role: "user",
        content: [
          {
            image: {
              format: format,
              source: {
                bytes: imageBytes
              }
            }
          },
          {
            text: promptText
          }
        ]
      }
    ],
    inferenceConfig: {
      maxTokens: 1000,
      temperature: 0.1
    }
  });

  try {
    const t0 = Date.now();
    const result = await bedrockClient.send(command);
    const tEnd = Date.now();
    
    console.log(`\n=== OUTPUT: ${modelId} ===`);
    console.log(`Time: ${tEnd - t0}ms`);
    console.log(`Input Tokens: ${result.usage.inputTokens}`);
    console.log(`Output Tokens: ${result.usage.outputTokens}`);
    console.log(`Response:\n${result.output.message.content[0].text}`);
    console.log(`===========================================\n`);
    
  } catch (err) {
    console.error(`\n=== FAILED: ${modelId} ===`);
    console.error(`Name: ${err.name}`);
    console.error(`Message: ${err.message}\n`);
  }
}

const testUrls = [
  "https://cwf-dev-assets.s3.us-west-2.amazonaws.com/organizations/00000000-0000-0000-0000-000000000001/images/PXL_20260329_040819900.jpg", // Compost pile texture
  "https://cwf-dev-assets.s3.us-west-2.amazonaws.com/organizations/00000000-0000-0000-0000-000000000001/images/PXL_20260329_051029213.jpg", // Watering containers
  "https://cwf-dev-assets.s3.us-west-2.amazonaws.com/organizations/00000000-0000-0000-0000-000000000001/images/PXL_20260329_042453621.jpg"  // Soil monitor in ground
];

async function main() {
  console.log("Starting Bedrock Vision Test with Amazon Nova Lite...\n");

  const modelId = 'us.amazon.nova-lite-v1:0';

  for (const url of testUrls) {
    console.log(`\nTesting Image: ${url}`);
    await runVisionTest(modelId, url);
  }
}

main();
