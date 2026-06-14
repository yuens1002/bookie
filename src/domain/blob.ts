import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Railway Bucket (AWS SDK Generic style) injects:
//   AWS_ENDPOINT_URL, AWS_S3_BUCKET_NAME, AWS_DEFAULT_REGION,
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
// The SDK auto-reads the AWS_* credential + region + endpoint vars;
// we only need to pass forcePathStyle for Tigris compatibility.
// https://docs.railway.com/storage-buckets

function makeClient(): S3Client {
  if (!process.env.AWS_ENDPOINT_URL || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
    throw new Error("Railway Bucket env vars missing: AWS_ENDPOINT_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY");
  return new S3Client({ forcePathStyle: true });
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
