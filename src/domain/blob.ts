import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Railway Bucket injects: ENDPOINT, BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY, REGION
// https://docs.railway.com/storage-buckets

function makeClient(): S3Client {
  const endpoint = process.env.ENDPOINT;
  const accessKeyId = process.env.ACCESS_KEY_ID;
  const secretAccessKey = process.env.SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey)
    throw new Error("Railway Bucket env vars missing: ENDPOINT, ACCESS_KEY_ID, SECRET_ACCESS_KEY");
  return new S3Client({
    endpoint,
    region: process.env.REGION ?? "auto",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

function bucketName(): string {
  const b = process.env.BUCKET;
  if (!b) throw new Error("Railway Bucket env var missing: BUCKET");
  return b;
}

export function blobConfigured(): boolean {
  return !!(process.env.ENDPOINT && process.env.ACCESS_KEY_ID && process.env.SECRET_ACCESS_KEY && process.env.BUCKET);
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
