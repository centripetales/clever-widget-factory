import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

const BUCKET = 'cwf-dev-assets';
const USE_ORG_SCOPED_KEYS = process.env.USE_ORG_SCOPED_KEYS === 'true';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const s3Client = new S3Client({
  region: 'us-west-2',
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

export const handler = async (event) => {
  console.log('Presigned URL request:', JSON.stringify(event, null, 2));

  try {
    const body = JSON.parse(event.body);
    const { filename, contentType } = body;

    if (!filename || !contentType) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'filename and contentType required' }),
      };
    }

    let key, finalKey;

    if (USE_ORG_SCOPED_KEYS) {
      const organizationId = event.requestContext?.authorizer?.organization_id;

      if (!organizationId) {
        console.error('Missing organization_id in authorizer context');
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ error: 'organization_id required for organization-scoped uploads' }),
        };
      }

      const random = Math.random().toString(36).substring(2, 9);
      key = `organizations/${organizationId}/images/uploads/${random}-${filename}`;
      finalKey = key.replace('/uploads/', '/');
      console.log('Organization-scoped upload:', { organizationId, filename, key, finalKey });
    } else {
      const random = Math.random().toString(36).substring(2, 11);
      key = `mission-attachments/uploads/${random}-${filename}`;
      finalKey = key.replace('/uploads/', '/');
      console.log('Mission-attachments upload:', { random, key, finalKey });
    }

    // Generate presigned POST — browser uploads via multipart/form-data
    // which is a "simple" CORS request (no preflight OPTIONS needed).
    const { url: postUrl, fields: postFields } = await createPresignedPost(s3Client, {
      Bucket: BUCKET,
      Key: key,
      Conditions: [
        ['content-length-range', 0, MAX_FILE_SIZE],
        ['starts-with', '$Content-Type', contentType.split('/')[0] + '/'],
      ],
      Fields: {
        'Content-Type': contentType,
      },
      Expires: 3600, // 1 hour
    });

    const publicUrl = `https://${BUCKET}.s3.us-west-2.amazonaws.com/${finalKey}`;

    console.log('Generated presigned POST:', { uploadKey: key, finalKey, publicUrl, postUrl });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        uploadMethod: 'post',
        postUrl,
        postFields,
        publicUrl,
        key,
      }),
    };
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Failed to generate presigned URL' }),
    };
  }
};
