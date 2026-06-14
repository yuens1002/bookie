import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Railway Bucket (AWS SDK Generic style) injects:
//   AWS_ENDPOINT_URL, AWS_S3_BUCKET_NAME, AWS_DEFAULT_REGION,
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
// The SDK auto-reads the AWS_* credential + endpoint vars, but NOT the region:
// AWS SDK v3 only reads AWS_REGION, not AWS_DEFAULT_REGION (a v2-only fallback),
// so Railway's AWS_DEFAULT_REGION must be passed explicitly or the client throws
// "Region is missing". forcePathStyle is required for Tigris compatibility.
// https://docs.railway.com/storage-buckets

function makeClient(): S3Client {
  if (!process.env.AWS_ENDPOINT_URL || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
    throw new Error("Railway Bucket env vars missing: AWS_ENDPOINT_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY");
  return new S3Client({
    forcePathStyle: true,
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "auto",
  });
}

function bucketName(): string {
  const b = process.env.AWS_S3_BUCKET_NAME;
  if (!b) throw new Error("Railway Bucket env var missing: AWS_S3_BUCKET_NAME");
  return b;
}

export function blobConfigured(): boolean {
  return !!(
    process.env.AWS_ENDPOINT_URL &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_S3_BUCKET_NAME
  );
}

export async function uploadFile(key: string, content: Buffer, mimeType: string): Promise<void> {
  await makeClient().send(
    new PutObjectCommand({ Bucket: bucketName(), Key: key, Body: content, ContentType: mimeType }),
  );
}

export async function getSignedDownloadUrl(key: string, ttlSecs = 3600): Promise<string> {
  return getSignedUrl(makeClient(), new GetObjectCommand({ Bucket: bucketName(), Key: key }), {
    expiresIn: ttlSecs,
  });
}

export async function deleteFile(key: string): Promise<void> {
  await makeClient().send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
}
